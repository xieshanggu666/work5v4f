import db, { getSetting, setSetting, tx } from './db.js'

// 游客会员与权益中心模块：
// 购卡（幂等+事务）/ 积分（发放·抵现·扣回·补偿·调账·清零）/ 等级状态流转（成长值衰减+持卡权益取高）
// 联动：票务预约折扣与积分、商铺消费折让、退款补偿积分、财务流水入账、客服人力配置
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d }

// ---------------- 等级与权益配置 ----------------
// 成长值达到阈值即享对应等级；持卡期间等级 = max(成长等级, 卡授予等级)
export const TIERS = [
  { level: 0, key: 'normal', name: '普通会员', icon: '⚪', growth: 0,    ticketDisc: 1,    rideDisc: 1,    vendorDisc: 1,    pointsRate: 1,   lateRefundFree: false },
  { level: 1, key: 'silver', name: '白银会员', icon: '🥈', growth: 800,  ticketDisc: 0.95, rideDisc: 0.95, vendorDisc: 0.97, pointsRate: 1.2, lateRefundFree: false },
  { level: 2, key: 'gold',   name: '黄金会员', icon: '🥇', growth: 3000, ticketDisc: 0.9,  rideDisc: 0.85, vendorDisc: 0.92, pointsRate: 1.5, lateRefundFree: true },
  { level: 3, key: 'black',  name: '黑钻会员', icon: '💎', growth: 8000, ticketDisc: 0.8,  rideDisc: 0.75, vendorDisc: 0.85, pointsRate: 2,   lateRefundFree: true }
]
export const tierMeta = lv => TIERS[Math.max(0, Math.min(3, num(lv)))] || TIERS[0]

const GROWTH_DECAY = 0.97          // 成长值每日衰减（驱动降级流转）
const POINTS_PER_YUAN = 1          // 每消费 ¥1 积 1 分（×等级倍率）
const POINT_VALUE = 0.1            // 积分抵现汇率：1 分 = ¥0.1
const REDEEM_MAX_RATIO = 0.3       // 单笔消费积分抵现上限 30%
const COMP_POINTS_REFUND = 200     // 园方原因退款补偿积分
const STAFF_CAPACITY = 60          // 每名客服每日可服务的会员数
const CARD_REFUND_RATIO = 0.8      // 退卡按剩余天数比例退款后再收 20% 手续费

// ---------------- 业务错误码 ----------------
export const MEMBER_ERR = {
  NOT_FOUND: 'MBR_NOT_FOUND',
  STATUS_CONFLICT: 'MBR_STATUS_CONFLICT',
  FROZEN: 'MBR_FROZEN',
  CARD_NOT_FOUND: 'CARD_NOT_FOUND',
  CARD_INACTIVE: 'CARD_INACTIVE',
  NO_ACTIVE_CARD: 'NO_ACTIVE_CARD',
  INSUFFICIENT_POINTS: 'INSUFFICIENT_POINTS',
  TX_FAILED: 'TX_FAILED'
}
const fail = (code, msg, extra = {}) => ({ ok: false, code, msg, ...extra })

class TxError extends Error {
  constructor(code, msg, extra = {}) { super(msg); this.code = code; this.extra = extra }
}

function runAtomic(fn) {
  try {
    return tx(fn)
  } catch (e) {
    if (e instanceof TxError) return fail(e.code, e.message, e.extra)
    console.error('[members] 事务执行失败，已整体回滚:', e)
    return fail(MEMBER_ERR.TX_FAILED, '系统繁忙，本次操作未生效，请稍后重试')
  }
}

// 幂等执行：与预约模块共用 idempotency_keys（scope 前缀 member_）
function idempotent(scope, requestId, fn) {
  const key = String(requestId || '').trim().slice(0, 80)
  if (!key) return fn()
  const hit = db.prepare('SELECT response FROM idempotency_keys WHERE scope=? AND key=?').get(scope, key)
  if (hit) return { ...JSON.parse(hit.response), replay: true }
  const result = fn()
  if (result?.code !== MEMBER_ERR.TX_FAILED) {
    db.prepare('INSERT OR IGNORE INTO idempotency_keys(scope,key,response,created_tick,created_day) VALUES(?,?,?,?,?)')
      .run(scope, key, JSON.stringify(result), ctx.tick(), ctx.day())
  }
  return result
}

// 由 index.js 注入共享上下文（时钟、现金、财务流水、投诉）
const ctx = {
  day: () => num(getSetting('day'), 1),
  hour: () => num(getSetting('hour'), 9),
  tick: () => num(getSetting('tick'), 0),
  cash: () => num(getSetting('cash'), 0),
  reputation: () => num(getSetting('reputation'), 70),
  logFinance: null,
  createComplaint: null
}
export function initMemberContext(deps) {
  Object.assign(ctx, deps)
}

// ---------------- 基础查询 ----------------
export const getMember = id => db.prepare('SELECT * FROM members WHERE id=?').get(num(id))
export const getMemberByCode = code => db.prepare('SELECT * FROM members WHERE code=?').get(String(code || '').trim())
const getCard = id => db.prepare('SELECT * FROM member_cards WHERE id=?').get(num(id))

// card_expire_day 语义：首个失效日（= 购卡日 + 有效天数，当日 card_expire_day 已失效）
function cardValid(m, day = ctx.day()) {
  return m && m.card_status === 'active' && m.card_expire_day > day
}
// 成长值对应等级
function growthTier(g) {
  let lv = 0
  for (const t of TIERS) if (g >= t.growth) lv = t.level
  return lv
}
// 有效等级 = max(成长等级, 持卡授予等级)
export function effectiveTier(m) {
  if (!m) return 0
  const cardLv = cardValid(m) ? num(getCard(m.card_id)?.grant_tier, 0) : 0
  return Math.max(growthTier(m.growth), cardLv)
}

// ---------------- 流水 ----------------
// 积分变动（须在事务内调用）：负向变动余额不足时夹断到 0 并在备注留痕
function applyPoints(memberId, delta, type, note = '') {
  const m = getMember(memberId)
  if (!m) throw new TxError(MEMBER_ERR.NOT_FOUND, '会员不存在')
  let real = Math.round(delta)
  if (real < 0 && m.points + real < 0) real = -m.points
  if (real === 0 && delta !== 0) return 0
  const balance = m.points + real
  db.prepare('UPDATE members SET points=? WHERE id=?').run(balance, memberId)
  db.prepare('INSERT INTO member_points_logs(member_id,tick,day,delta,balance,type,note) VALUES(?,?,?,?,?,?,?)')
    .run(memberId, ctx.tick(), ctx.day(), real, balance, type, note)
  return real
}

function logTier(memberId, fromTier, toTier, reason, note = '') {
  db.prepare('INSERT INTO member_tier_logs(member_id,tick,day,from_tier,to_tier,reason,note) VALUES(?,?,?,?,?,?,?)')
    .run(memberId, ctx.tick(), ctx.day(), fromTier, toTier, reason, note)
}

// 重算并落库会员等级（成长等级与持卡等级取高），等级变化时写流转日志
function syncTier(memberId, reason, note = '') {
  const m = getMember(memberId)
  if (!m) return 0
  const to = effectiveTier(m)
  if (to !== m.tier) {
    db.prepare('UPDATE members SET tier=? WHERE id=?').run(to, memberId)
    logTier(memberId, m.tier, to, reason,
      note || `${tierMeta(m.tier).name} → ${tierMeta(to).name}`)
  }
  return to
}

// ---------------- 注册 / 购卡 / 退卡 ----------------
// 注册会员（前台登记 manual / 模拟注册 auto）
export function enrollMember({ name, phone = '', source = 'manual' } = {}) {
  return runAtomic(() => {
    const r = db.prepare(`INSERT INTO members(code,name,phone,tier,points,growth,status,source,join_day,created_tick)
                          VALUES('',?,?,0,0,0,'active',?,?,?)`)
      .run(String(name || '会员').slice(0, 12), String(phone || '').slice(0, 20), source, ctx.day(), ctx.tick())
    const id = Number(r.lastInsertRowid)
    const code = 'M' + String(id).padStart(4, '0')
    db.prepare('UPDATE members SET code=? WHERE id=?').run(code, id)
    logTier(id, 0, 0, 'enroll', source === 'manual' ? '前台登记入会' : '游客注册成为会员')
    return { ok: true, id, code }
  })
}

// 购卡/续卡：收款入账 + 订单 + 持卡权益 + 赠分 + 等级授予，同事务；requestId 幂等防重复扣款
// 续卡顺延：当前卡未到期时，新卡有效期自原到期日起累加
export function purchaseCard(memberId, cardId, requestId = '', source = 'manual') {
  return idempotent('member_purchase', requestId, () => {
    const m = getMember(memberId)
    if (!m) return fail(MEMBER_ERR.NOT_FOUND, '会员不存在')
    if (m.status === 'frozen') return fail(MEMBER_ERR.FROZEN, '该会员已冻结，不可购卡')
    const card = getCard(cardId)
    if (!card) return fail(MEMBER_ERR.CARD_NOT_FOUND, '卡种不存在')
    if (!card.active) return fail(MEMBER_ERR.CARD_INACTIVE, '该卡种已下架')

    return runAtomic(() => {
      const today = ctx.day()
      const baseDay = cardValid(m, today) ? m.card_expire_day : today
      const endDay = baseDay + card.valid_days
      const r = db.prepare(`INSERT INTO member_orders(code,member_id,card_id,card_name,price,status,start_day,end_day,created_tick,created_day)
                            VALUES('',?,?,?,?,'done',?,?,?,?)`)
        .run(m.id, card.id, card.name, card.price, today, endDay, ctx.tick(), today)
      const oid = Number(r.lastInsertRowid)
      const code = 'KA' + String(oid).padStart(4, '0')
      db.prepare('UPDATE member_orders SET code=? WHERE id=?').run(code, oid)

      // 售卡收入入账（现金制）
      setSetting('cash', Math.round(ctx.cash() + card.price))
      ctx.logFinance?.(today, '会员卡', card.price, `售卡 ${code} · ${m.code} 购买「${card.name}」`)

      db.prepare(`UPDATE members SET card_id=?, card_expire_day=?, card_status='active' WHERE id=?`)
        .run(card.id, endDay, m.id)
      if (card.bonus_points > 0) applyPoints(m.id, card.bonus_points, 'card_bonus', `购买「${card.name}」赠 ${card.bonus_points} 积分`)
      syncTier(m.id, 'card_grant', `购卡「${card.name}」授予${tierMeta(card.grant_tier).name}权益`)
      return { ok: true, id: oid, code, end_day: endDay, price: card.price }
    })
  })
}

// 退卡：按剩余天数比例退款（收 20% 手续费），积分清零，等级按成长值回落
export function refundCard(memberId, requestId = '') {
  return idempotent('member_card_refund', requestId, () => {
    const m = getMember(memberId)
    if (!m) return fail(MEMBER_ERR.NOT_FOUND, '会员不存在')
    if (!cardValid(m)) return fail(MEMBER_ERR.NO_ACTIVE_CARD, '该会员无在有效期内的会员卡')
    const card = getCard(m.card_id)
    const order = db.prepare(`SELECT * FROM member_orders WHERE member_id=? AND status='done' ORDER BY id DESC LIMIT 1`).get(m.id)
    if (!card || !order) return fail(MEMBER_ERR.STATUS_CONFLICT, '未找到可退的购卡订单')

    return runAtomic(() => {
      const today = ctx.day()
      const remainDays = Math.max(0, m.card_expire_day - today)
      const refund = Math.round(order.price * (remainDays / card.valid_days) * CARD_REFUND_RATIO)

      const u = db.prepare(`UPDATE member_orders SET status='refunded', refund_amount=?, closed_day=? WHERE id=? AND status='done'`)
        .run(refund, today, order.id)
      if (u.changes === 0) throw new TxError(MEMBER_ERR.STATUS_CONFLICT, '订单状态已变更，请刷新后重试')

      if (refund > 0) {
        setSetting('cash', Math.round(ctx.cash() - refund))
        ctx.logFinance?.(today, '会员退款', -refund, `退卡 ${order.code} · ${m.code}「${card.name}」剩余 ${remainDays} 天`)
      }
      db.prepare(`UPDATE members SET card_status='refunded', card_id=NULL, card_expire_day=0 WHERE id=?`).run(m.id)
      const cleared = applyPoints(m.id, -(getMember(m.id).points), 'clear', `退卡「${card.name}」，积分清零`)
      syncTier(m.id, 'card_refund', `退卡「${card.name}」，持卡权益失效`)
      return { ok: true, refund, cleared: Math.abs(cleared) }
    })
  })
}

// 运营调账：积分补发（正）/ 扣减（负），requestId 幂等
export function adjustPoints(memberId, delta, reason = '', requestId = '') {
  return idempotent('member_adjust', requestId, () => {
    const m = getMember(memberId)
    if (!m) return fail(MEMBER_ERR.NOT_FOUND, '会员不存在')
    const d = Math.round(num(delta))
    if (!d) return fail(MEMBER_ERR.STATUS_CONFLICT, '调整积分数不能为 0')
    if (d < 0 && m.points + d < 0) return fail(MEMBER_ERR.INSUFFICIENT_POINTS, `积分余额不足（当前 ${m.points}），无法扣减 ${-d}`)
    return runAtomic(() => {
      applyPoints(m.id, d, 'adjust', reason || (d > 0 ? '运营补发积分' : '运营扣减积分'))
      return { ok: true, balance: getMember(m.id).points }
    })
  })
}

// 冻结 / 解冻（冻结期间不可购卡、不累积积分与成长）
export function setMemberStatus(memberId, action) {
  const m = getMember(memberId)
  if (!m) return fail(MEMBER_ERR.NOT_FOUND, '会员不存在')
  const to = action === 'freeze' ? 'frozen' : 'active'
  if (m.status === to) return fail(MEMBER_ERR.STATUS_CONFLICT, `会员已处于${to === 'frozen' ? '冻结' : '正常'}状态`)
  db.prepare('UPDATE members SET status=? WHERE id=?').run(to, m.id)
  return { ok: true, status: to }
}

// ---------------- 消费积分 / 抵现（票务·商铺联动共用） ----------------
// 消费累积：积分 ×等级倍率 + 成长值（冻结会员不累积）；须在事务内调用
export function earnFromSpend(memberId, amount, note = '') {
  const m = getMember(memberId)
  if (!m || m.status !== 'active' || amount <= 0) return 0
  const tier = tierMeta(m.tier)
  const pts = Math.round(amount * POINTS_PER_YUAN * tier.pointsRate)
  db.prepare('UPDATE members SET growth=growth+?, total_spend=total_spend+?, last_visit_day=? WHERE id=?')
    .run(Math.round(amount), Math.round(amount), ctx.day(), memberId)
  if (pts > 0) applyPoints(memberId, pts, 'consume', note || `消费 ¥${Math.round(amount)} 积 ${pts} 分（${tier.name} ×${tier.pointsRate}）`)
  return pts
}

// 积分抵现：返回实际抵扣的 { points, value }；须在事务内调用
export function redeemPoints(memberId, maxValue) {
  const m = getMember(memberId)
  if (!m || m.status !== 'active') return { points: 0, value: 0 }
  const usable = Math.min(Math.floor(maxValue / POINT_VALUE), m.points)
  if (usable <= 0) return { points: 0, value: 0 }
  applyPoints(memberId, -usable, 'redeem', `积分抵现 ${usable} 分抵 ¥${Math.round(usable * POINT_VALUE * 100) / 100}`)
  return { points: usable, value: Math.round(usable * POINT_VALUE * 100) / 100 }
}

// ---------------- 预约（票务）联动钩子 ----------------
// 会员预约定价：返回票价折扣与退票权益（reservations.js 建单时调用）
export function memberPricing(memberId) {
  const m = getMember(memberId)
  if (!m) return { ok: false }
  if (m.status !== 'active') return { ok: false, msg: '会员已冻结，无法享受会员权益' }
  const t = tierMeta(m.tier)
  return { ok: true, member: m, tier: t, ticketDisc: t.ticketDisc, rideDisc: t.rideDisc, lateRefundFree: t.lateRefundFree }
}

// 预约建单后：按实付金额累积积分与成长（reservations.js 同事务调用）
export function onReservationBooked(rsv) {
  if (!rsv.member_id) return
  earnFromSpend(rsv.member_id, rsv.amount, `预约 ${rsv.code} 消费 ¥${rsv.amount}`)
}

// 预约退款后：扣回已发积分；园方原因（park/overbook）追加补偿积分（reservations.js 同事务调用）
export function onReservationRefund(rsv, reason) {
  if (!rsv.member_id) return
  const m = getMember(rsv.member_id)
  if (!m) return
  const t = tierMeta(m.tier)
  const earned = Math.round(rsv.amount * POINTS_PER_YUAN * t.pointsRate)
  if (earned > 0) applyPoints(m.id, -earned, 'clawback', `预约 ${rsv.code} 退款，扣回消费积分 ${earned}`)
  if (reason === 'park' || reason === 'overbook') {
    applyPoints(m.id, COMP_POINTS_REFUND, 'compensate', `预约 ${rsv.code} 园方原因退款，补偿 ${COMP_POINTS_REFUND} 积分`)
  }
}

// ---------------- 引擎：每日等级流转 + 服务压力 ----------------
// 每日日结调用：成长值衰减 → 等级重算（升/降级流转）；卡到期 → 持卡权益失效；客服不足 → 服务投诉
export function dailyMemberSettlement(day) {
  // 0) 新的一天：重置当日活动统计
  setSetting('member_activity', JSON.stringify({ day, enrolled: 0, cardsSold: 0, visits: 0, spend: 0, discountCost: 0, redeemValue: 0 }))
  // 1) 成长值衰减
  db.prepare('UPDATE members SET growth=ROUND(growth * ?) WHERE growth>0').run(GROWTH_DECAY)
  // 2) 卡到期（card_expire_day 为首个失效日，到达即失效）
  const expired = db.prepare(`SELECT * FROM members WHERE card_status='active' AND card_expire_day <= ?`).all(day)
  for (const m of expired) {
    db.prepare(`UPDATE members SET card_status='expired' WHERE id=?`).run(m.id)
    syncTier(m.id, 'card_expire', `会员卡到期（第 ${m.card_expire_day} 天），持卡权益失效`)
  }
  // 3) 成长驱动的等级流转（升级/降级）
  const actives = db.prepare(`SELECT id FROM members WHERE status='active'`).all()
  let ups = 0, downs = 0
  for (const { id } of actives) {
    const m = getMember(id)
    const to = effectiveTier(m)
    if (to !== m.tier) {
      syncTier(id, to > m.tier ? 'upgrade' : 'downgrade')
      to > m.tier ? ups++ : downs++
    }
  }
  // 4) 客服服务能力：会员数超出客服承载 → 会员服务投诉
  const staff = serviceStaff()
  const memberCount = db.prepare(`SELECT COUNT(*) n FROM members WHERE status='active'`).get().n
  const capacity = staff.count * STAFF_CAPACITY
  if (memberCount > capacity && Math.random() < Math.min(0.5, (memberCount - capacity) / 400)) {
    ctx.createComplaint?.({
      category: 'service', severity: memberCount > capacity * 2 ? 2 : 1,
      title: '会员服务响应慢 · 会员中心',
      content: `在册会员 ${memberCount} 人，客服专员仅 ${staff.count} 人（承载 ${capacity}），会员咨询与权益办理排队过久。`,
      target: { type: '', id: null, name: '' }, source: 'guest'
    })
  }
  return { ups, downs, expired: expired.length, memberCount, staffCount: staff.count, capacity }
}

// 客服（会员专员）配置：数量 / 平均技能 / 平均士气
export function serviceStaff() {
  const rows = db.prepare(`SELECT * FROM staff WHERE role='客服' AND active=1`).all()
  const avg = k => rows.length ? rows.reduce((s, r) => s + r[k], 0) / rows.length : 0
  return { count: rows.length, avgSkill: Math.round(avg('skill') * 10) / 10, avgMorale: Math.round(avg('morale')) }
}

// ---------------- 引擎：模拟需求（注册/购卡/会员消费） ----------------
const SURNAMES = ['王', '李', '张', '刘', '陈', '杨', '赵', '黄', '周', '吴', '徐', '孙', '林', '何']
const GIVEN = ['伟', '芳', '娜', '敏', '静', '磊', '洋', '勇', '艳', '杰', '涛', '明', '超', '雪']
const rname = () => SURNAMES[Math.floor(Math.random() * SURNAMES.length)] + GIVEN[Math.floor(Math.random() * GIVEN.length)]

// 每个营业小时调用：新会员注册、会员购卡、会员到店消费（折让+积分抵现+积分累积）
// 返回 { enrolled, cardsSold, visits, spend, discountCost, redeemValue } 供统计与现金核算
export function simulateMemberActivity(entering, avgSpend) {
  const today = ctx.day()
  const staff = serviceStaff()
  const staffBoost = 1 + Math.min(0.6, staff.count * 0.15 * (0.6 + staff.avgSkill / 5))
  const repFactor = 0.5 + ctx.reputation() / 100
  const out = { enrolled: 0, cardsSold: 0, visits: 0, spend: 0, discountCost: 0, redeemValue: 0 }

  // 1) 新会员注册：客流 × 转化（声誉/客服加成）
  const enrolls = Math.round(entering * 0.004 * repFactor * staffBoost * (0.6 + Math.random() * 0.8))
  for (let i = 0; i < Math.min(enrolls, 12); i++) {
    const r = enrollMember({ name: rname(), source: 'auto' })
    if (r.ok) out.enrolled++
  }

  // 2) 无卡会员购卡：转化率随声誉与客服配置提升
  const candidates = db.prepare(`SELECT * FROM members WHERE status='active' AND card_status IN ('none','expired','refunded') ORDER BY RANDOM() LIMIT 30`).all()
  const cards = db.prepare('SELECT * FROM member_cards WHERE active=1 ORDER BY price').all()
  for (const m of candidates) {
    if (out.cardsSold >= 6 || !cards.length) break
    const p = 0.05 * repFactor * staffBoost
    if (Math.random() >= p) continue
    // 成长值越高的会员越倾向买高档卡
    const card = m.growth >= 2000 && cards[2] ? cards[2] : m.growth >= 500 && cards[1] ? cards[1] : cards[0]
    const r = purchaseCard(m.id, card.id, '', 'auto')
    if (r.ok) out.cardsSold++
  }

  // 3) 会员到店消费：抽样会员代表今日到店会员，折让与抵现为公园侧成本，消费累积积分与成长
  const actives = db.prepare(`SELECT * FROM members WHERE status='active' ORDER BY RANDOM() LIMIT 12`).all()
  const totalMembers = db.prepare(`SELECT COUNT(*) n FROM members WHERE status='active'`).get().n
  const visits = Math.min(Math.round(totalMembers * 0.06), Math.round(entering * 0.3))
  if (visits > 0 && actives.length) {
    const perVisit = Math.max(20, Math.round(avgSpend))
    const basket = Math.round((visits * perVisit) / actives.length)
    runAtomic(() => {
      for (const m of actives) {
        const t = tierMeta(m.tier)
        // 混合折扣（门票/游乐/商铺综合），园方让利于财务单列「会员优惠」
        const blendDisc = (t.ticketDisc + t.rideDisc + t.vendorDisc) / 3
        const discount = Math.round(basket * (1 - blendDisc))
        // 积分抵现：单笔最多抵 30%
        const maxRedeem = basket * REDEEM_MAX_RATIO
        const used = redeemPoints(m.id, maxRedeem)
        const paid = basket - used.value
        out.discountCost += discount
        out.redeemValue += used.value
        out.spend += basket
        earnFromSpend(m.id, paid, `到店消费 ¥${paid}（会员通道）`)
      }
      const cost = Math.round(out.discountCost + out.redeemValue)
      if (cost > 0) {
        setSetting('cash', Math.round(ctx.cash() - cost))
        ctx.logFinance?.(today, '会员优惠', -Math.round(out.discountCost), `会员到店 ${visits} 人次折让`)
        ctx.logFinance?.(today, '积分抵现', -Math.round(out.redeemValue), `会员积分抵现`)
      }
      return { ok: true }
    })
    out.visits = visits
  }
  bumpActivity(out)
  return out
}

// 当日活动动态按设置项累积（日结重置），供看板展示
function bumpActivity(part) {
  const cur = todayActivity()
  for (const k of ['enrolled', 'cardsSold', 'visits', 'spend', 'discountCost', 'redeemValue']) cur[k] = (cur[k] || 0) + (part[k] || 0)
  setSetting('member_activity', JSON.stringify(cur))
}
export function todayActivity() {
  try {
    const v = JSON.parse(getSetting('member_activity') || '{}')
    if (v.day === ctx.day()) return v
  } catch { /* 忽略损坏 JSON */ }
  return { day: ctx.day(), enrolled: 0, cardsSold: 0, visits: 0, spend: 0, discountCost: 0, redeemValue: 0 }
}

// ---------------- 查询与统计 ----------------
export function listMembers({ status = null, tier = null, q = '', limit = 120 } = {}) {
  const conds = []
  const vals = []
  if (status) { conds.push('status=?'); vals.push(status) }
  if (tier !== null && tier !== '' && tier !== undefined) { conds.push('tier=?'); vals.push(num(tier)) }
  if (q) { conds.push('(code LIKE ? OR name LIKE ? OR phone LIKE ?)'); vals.push(`%${q}%`, `%${q}%`, `%${q}%`) }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
  const rows = db.prepare(`SELECT * FROM members ${where} ORDER BY id DESC LIMIT ?`).all(...vals, num(limit, 120))
  const today = ctx.day()
  return rows.map(m => enrichMember(m, today))
}

function enrichMember(m, today = ctx.day()) {
  const t = tierMeta(m.tier)
  const card = m.card_id ? getCard(m.card_id) : null
  return {
    ...m,
    tier_name: t.name,
    tier_icon: t.icon,
    card_name: card?.name || '',
    card_valid: cardValid(m, today),
    card_remain_days: cardValid(m, today) ? m.card_expire_day - today : 0,
    growth_tier: growthTier(m.growth),
    next_tier: m.tier < 3 ? TIERS[m.tier + 1].name : '',
    next_tier_growth: m.tier < 3 ? TIERS[m.tier + 1].growth : 0
  }
}

export function memberDetail(id) {
  const m = getMember(id)
  if (!m) return null
  return {
    member: enrichMember(m),
    orders: db.prepare('SELECT * FROM member_orders WHERE member_id=? ORDER BY id DESC LIMIT 20').all(m.id),
    pointsLogs: db.prepare('SELECT * FROM member_points_logs WHERE member_id=? ORDER BY id DESC LIMIT 40').all(m.id),
    tierLogs: db.prepare('SELECT * FROM member_tier_logs WHERE member_id=? ORDER BY id DESC LIMIT 20').all(m.id)
  }
}

export const listCards = () => db.prepare('SELECT * FROM member_cards ORDER BY price').all()

// 全局积分流水 / 等级流转（会员中心流水页签）
export function recentMemberLogs(limit = 60) {
  const points = db.prepare(`SELECT p.*, m.code AS member_code, m.name AS member_name
                             FROM member_points_logs p JOIN members m ON m.id=p.member_id
                             ORDER BY p.id DESC LIMIT ?`).all(limit)
  const tiers = db.prepare(`SELECT t.*, m.code AS member_code, m.name AS member_name
                            FROM member_tier_logs t JOIN members m ON m.id=t.member_id
                            ORDER BY t.id DESC LIMIT ?`).all(limit)
  return { points, tiers }
}

// 新增卡种（运营配置）
export function createCard({ name, price, valid_days, grant_tier, bonus_points }) {
  const p = Math.round(num(price)), vd = Math.round(num(valid_days)), gt = Math.round(num(grant_tier, 1))
  if (!String(name || '').trim()) return fail(MEMBER_ERR.STATUS_CONFLICT, '请填写卡种名称')
  if (!(p > 0)) return fail(MEMBER_ERR.STATUS_CONFLICT, '售价需大于 0')
  if (!(vd >= 1 && vd <= 3650)) return fail(MEMBER_ERR.STATUS_CONFLICT, '有效天数需在 1~3650 之间')
  if (!(gt >= 1 && gt <= 3)) return fail(MEMBER_ERR.STATUS_CONFLICT, '授予等级需为 1~3')
  const r = db.prepare('INSERT INTO member_cards(name,price,valid_days,grant_tier,bonus_points,active,created_day) VALUES(?,?,?,?,?,1,?)')
    .run(String(name).slice(0, 12), p, vd, gt, Math.max(0, Math.round(num(bonus_points))), ctx.day())
  return { ok: true, id: Number(r.lastInsertRowid) }
}

// 修改卡种：调价 / 赠分 / 上下架（不影响已售出的卡）
export function updateCard(id, patch = {}) {
  const card = getCard(id)
  if (!card) return fail(MEMBER_ERR.CARD_NOT_FOUND, '卡种不存在')
  const sets = []
  const vals = []
  if (patch.price !== undefined) {
    const p = Math.round(num(patch.price))
    if (!(p > 0)) return fail(MEMBER_ERR.STATUS_CONFLICT, '售价需大于 0')
    sets.push('price=?'); vals.push(p)
  }
  if (patch.bonus_points !== undefined) { sets.push('bonus_points=?'); vals.push(Math.max(0, Math.round(num(patch.bonus_points)))) }
  if (patch.active !== undefined) { sets.push('active=?'); vals.push(patch.active ? 1 : 0) }
  if (!sets.length) return fail(MEMBER_ERR.STATUS_CONFLICT, '无更新项')
  vals.push(card.id)
  db.prepare(`UPDATE member_cards SET ${sets.join(',')} WHERE id=?`).run(...vals)
  return { ok: true }
}

// 会员中心统计（含客服配置与今日动态）
export function memberStats() {
  const today = ctx.day()
  const one = (sql, ...v) => db.prepare(sql).get(...v)
  const total = one(`SELECT COUNT(*) n FROM members`).n
  const active = one(`SELECT COUNT(*) n FROM members WHERE status='active'`).n
  const frozen = one(`SELECT COUNT(*) n FROM members WHERE status='frozen'`).n
  const cardHolders = one(`SELECT COUNT(*) n FROM members WHERE card_status='active' AND card_expire_day>?`, today).n
  const todayNew = one(`SELECT COUNT(*) n FROM members WHERE join_day=?`, today).n
  const tiers = db.prepare(`SELECT tier, COUNT(*) n FROM members WHERE status='active' GROUP BY tier`).all()
  const pointsOut = one(`SELECT COALESCE(SUM(delta),0) s FROM member_points_logs WHERE delta>0`).s
  const pointsUsed = one(`SELECT COALESCE(SUM(-delta),0) s FROM member_points_logs WHERE delta<0`).s
  const pointsLive = one(`SELECT COALESCE(SUM(points),0) s FROM members`).s
  const cardRevToday = one(`SELECT COALESCE(SUM(price),0) s FROM member_orders WHERE created_day=? AND status='done'`, today).s
  const cardsToday = one(`SELECT COUNT(*) n FROM member_orders WHERE created_day=?`, today).n
  const refundToday = one(`SELECT COALESCE(SUM(refund_amount),0) s FROM member_orders WHERE status='refunded' AND closed_day=?`, today).s
  const staff = serviceStaff()
  return {
    total, active, frozen, cardHolders, todayNew,
    tierDist: TIERS.map(t => ({ ...t, count: tiers.find(x => x.tier === t.level)?.n || 0 })),
    pointsOut, pointsUsed, pointsLive,
    cardRevToday, cardsToday, refundToday,
    staffCount: staff.count, staffCapacity: staff.count * STAFF_CAPACITY,
    activity: todayActivity()
  }
}

export const MEMBER_CONST = { POINT_VALUE, REDEEM_MAX_RATIO, COMP_POINTS_REFUND, STAFF_CAPACITY, GROWTH_DECAY, CARD_REFUND_RATIO }
