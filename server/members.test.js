// 会员与权益中心一致性测试：
// 购卡幂等 / 等级状态流转 / 退卡退款 / 积分台账 / 预约联动（折扣·积分·免手续费·补偿）/ 失败回滚
// 运行：node --test server/members.test.js（需 Node >= 22.5，node:sqlite）
process.env.PARK_DB_PATH = ':memory:'   // 必须在导入 db.js 前设置，隔离真实库

import { test, before } from 'node:test'
import assert from 'node:assert/strict'

const { default: db, getSetting, setSetting } = await import('./db.js')
const M = await import('./members.js')
const RSV = await import('./reservations.js')

// ---- 测试上下文：记录财务流水与投诉，替代 index.js 的真实实现 ----
const finLogs = []
const complaints = []
const realLogFinance = (day, label, amount, detail) => finLogs.push({ day, label, amount, detail })
const fakeComplaint = p => { complaints.push(p); return { id: complaints.length, code: 'TS' + String(complaints.length).padStart(4, '0') } }
M.initMemberContext({ logFinance: realLogFinance, createComplaint: fakeComplaint })
RSV.initReservationContext({ logFinance: realLogFinance, createComplaint: fakeComplaint })

const cash = () => Number(getSetting('cash'))
const member = id => db.prepare('SELECT * FROM members WHERE id=?').get(id)
const pointsOf = id => member(id).points
const cardOf = name => db.prepare('SELECT * FROM member_cards WHERE name=?').get(name)
const orderCount = () => db.prepare('SELECT COUNT(*) n FROM member_orders').get().n
const tierLogs = id => db.prepare('SELECT * FROM member_tier_logs WHERE member_id=? ORDER BY id').all(id)
const pointsLogs = id => db.prepare('SELECT * FROM member_points_logs WHERE member_id=? ORDER BY id').all(id)

before(() => {
  setSetting('day', 1)
  setSetting('hour', 9)
  setSetting('tick', 0)
  setSetting('cash', 100000)
  setSetting('ticket', 100)
  setSetting('reputation', 70)
  RSV.ensureSlots()
})

test('注册会员：生成会员号并记录入会流转日志', () => {
  const r = M.enrollMember({ name: '测试会员', source: 'manual' })
  assert.equal(r.ok, true)
  const m = member(r.id)
  assert.equal(m.code, 'M' + String(r.id).padStart(4, '0'))
  assert.equal(m.tier, 0)
  assert.equal(tierLogs(r.id).some(l => l.reason === 'enroll'), true)
})

test('购卡幂等：同一 requestId 重复购卡只出一单、只收一次款、只赠一次分', () => {
  const m = M.enrollMember({ name: '购卡甲', source: 'manual' })
  const card = cardOf('月卡')
  const before = { cash: cash(), orders: orderCount() }

  const r1 = M.purchaseCard(m.id, card.id, 't-purchase-1')
  const r2 = M.purchaseCard(m.id, card.id, 't-purchase-1')   // 双击/重试重放

  assert.equal(r1.ok, true)
  assert.equal(r2.ok, true)
  assert.equal(r2.replay, true, '第二次应命中幂等缓存')
  assert.equal(r2.code, r1.code)
  assert.equal(orderCount(), before.orders + 1, '只应产生一张购卡订单')
  assert.equal(cash(), before.cash + card.price, '售卡款只入账一次')
  const mm = member(m.id)
  assert.equal(mm.card_status, 'active')
  assert.equal(mm.points, card.bonus_points, '赠分只发一次')
  assert.equal(mm.tier, 1, '月卡授予白银等级')
  assert.equal(mm.card_expire_day, 1 + card.valid_days, '到期日=购卡日+有效天数')
})

test('续卡顺延：未到期续卡自原到期日累加有效期', () => {
  const m = M.enrollMember({ name: '续卡乙', source: 'manual' })
  const card = cardOf('月卡')
  M.purchaseCard(m.id, card.id, 't-renew-1')
  const firstExpire = member(m.id).card_expire_day
  const r = M.purchaseCard(m.id, card.id, 't-renew-2')
  assert.equal(r.ok, true)
  assert.equal(member(m.id).card_expire_day, firstExpire + card.valid_days, '续卡应顺延累加')
})

test('等级状态流转：成长值升级 → 衰减降级；卡到期权益失效回落', () => {
  const m = M.enrollMember({ name: '成长丙', source: 'manual' })
  // 消费累积成长值（黄金线 3000）
  db.prepare('UPDATE members SET growth=3500 WHERE id=?').run(m.id)
  M.dailyMemberSettlement(2)
  assert.equal(member(m.id).tier, 2, '成长值 3500 应升黄金')
  assert.equal(tierLogs(m.id).some(l => l.reason === 'upgrade'), true)

  // 成长值衰减到白银线以下 → 降级
  db.prepare('UPDATE members SET growth=100 WHERE id=?').run(m.id)
  M.dailyMemberSettlement(3)
  assert.equal(member(m.id).tier, 0, '成长值衰减后应降回普通')
  assert.equal(tierLogs(m.id).some(l => l.reason === 'downgrade'), true)

  // 购年卡授予黑钻；手动令卡过期 → 权益失效回落
  const yearCard = cardOf('年卡')
  M.purchaseCard(m.id, yearCard.id, 't-tier-card-1')
  assert.equal(member(m.id).tier, 3, '年卡授予黑钻')
  db.prepare('UPDATE members SET card_expire_day=3 WHERE id=?').run(m.id)
  M.dailyMemberSettlement(4)
  const mm = member(m.id)
  assert.equal(mm.card_status, 'expired')
  assert.equal(mm.tier, 0, '卡到期后等级按成长值回落')
  assert.equal(tierLogs(m.id).some(l => l.reason === 'card_expire'), true)
})

test('退卡：按剩余天数比例退款、积分清零、等级回落；幂等重放不重复退款', () => {
  const m = M.enrollMember({ name: '退卡丁', source: 'manual' })
  const card = cardOf('月卡')   // 388 / 30 天 / 白银 / 赠 200 分
  M.purchaseCard(m.id, card.id, 't-refund-p1')
  // 第 1 天购买，第 11 天退卡：剩余 20 天 → 388 * 20/30 * 0.8 ≈ 207
  setSetting('day', 11)
  const before = cash()
  const r1 = M.refundCard(m.id, 't-refund-1')
  const expectRefund = Math.round(card.price * (20 / 30) * 0.8)
  assert.equal(r1.ok, true)
  assert.equal(r1.refund, expectRefund)
  assert.equal(cash(), before - expectRefund, '退款冲减现金')
  const mm = member(m.id)
  assert.equal(mm.card_status, 'refunded')
  assert.equal(mm.points, 0, '退卡积分清零')
  assert.equal(mm.tier, 0, '退卡后等级回落')
  assert.equal(pointsLogs(m.id).some(l => l.type === 'clear'), true)

  const r2 = M.refundCard(m.id, 't-refund-1')
  assert.equal(r2.replay, true, '重放返回首次结果')
  assert.equal(cash(), before - expectRefund, '不重复退款')
  setSetting('day', 1)
})

test('积分调账：补发/扣减留痕；余额不足拒绝扣减', () => {
  const m = M.enrollMember({ name: '调账戊', source: 'manual' })
  const r1 = M.adjustPoints(m.id, 500, '活动奖励', 't-adj-1')
  assert.equal(r1.ok, true)
  assert.equal(pointsOf(m.id), 500)
  const r2 = M.adjustPoints(m.id, -600, '违规扣减', 't-adj-2')
  assert.equal(r2.ok, false)
  assert.equal(r2.code, 'INSUFFICIENT_POINTS')
  const r3 = M.adjustPoints(m.id, -200, '部分扣减', 't-adj-3')
  assert.equal(r3.ok, true)
  assert.equal(pointsOf(m.id), 300)
  assert.equal(pointsLogs(m.id).filter(l => l.type === 'adjust').length, 2)
})

test('预约联动：会员折扣计价、建单积分、退款扣回、园方原因补偿', () => {
  const m = M.enrollMember({ name: '联动己', source: 'manual' })
  // 黄金会员（门票 9 折、积分 1.5 倍、当日取消免手续费）
  db.prepare("UPDATE members SET tier=2, growth=4000 WHERE id=?").run(m.id)
  const slot = db.prepare("SELECT * FROM reservation_slots WHERE scope='entry' AND day=1 AND hour=10").get()
  const before = { cash: cash() }

  const r = RSV.createReservation({ scope: 'entry', slotId: slot.id, qty: 2, memberCode: member(m.id).code, requestId: 't-link-1' })
  assert.equal(r.ok, true)
  // 票价 100 × 2 人 × 0.9 = 180
  assert.equal(cash(), before.cash + 180, '会员价 9 折入账')
  assert.equal(pointsOf(m.id), Math.round(180 * 1.5), '黄金 1.5 倍积分')

  // 当日取消：黄金免手续费（全额退），扣回积分
  setSetting('hour', 9)   // 时段 10:00 未开始，可取消
  const c = RSV.cancelReservation(r.id, 't-link-cancel-1')
  assert.equal(c.ok, true)
  assert.equal(c.back, 180, '黄金会员当日取消免手续费全额退')
  assert.equal(c.fee, 0)
  assert.equal(pointsOf(m.id), 0, '退款扣回消费积分')
  assert.equal(pointsLogs(m.id).some(l => l.type === 'clawback'), true)

  // 园方原因退款 → 补偿积分
  const r2 = RSV.createReservation({ scope: 'entry', slotId: slot.id, qty: 1, memberCode: member(m.id).code, requestId: 't-link-2' })
  assert.equal(r2.ok, true)
  const rsv = db.prepare('SELECT * FROM reservations WHERE id=?').get(r2.id)
  const rf = RSV.refundReservation(rsv, 'park', '设施停运园方退款')
  assert.equal(rf.ok, true)
  assert.equal(pointsOf(m.id), 200, '园方原因退款补偿 200 积分')
  assert.equal(pointsLogs(m.id).some(l => l.type === 'compensate'), true)
})

test('失败回滚：购卡事务中途异常（流水写入失败）→ 订单/现金/积分/等级全部回滚', () => {
  const m = M.enrollMember({ name: '回滚庚', source: 'manual' })
  const card = cardOf('季卡')
  const before = { cash: cash(), orders: orderCount(), points: pointsOf(m.id), tier: member(m.id).tier }

  M.initMemberContext({ logFinance: () => { throw new Error('模拟流水写入失败') }, createComplaint: fakeComplaint })
  const r = M.purchaseCard(m.id, card.id, 't-tx-1')
  M.initMemberContext({ logFinance: realLogFinance, createComplaint: fakeComplaint })

  assert.equal(r.ok, false)
  assert.equal(r.code, 'TX_FAILED')
  assert.equal(orderCount(), before.orders, '不得产生订单')
  assert.equal(cash(), before.cash, '现金不得变化')
  assert.equal(pointsOf(m.id), before.points, '积分不得变化')
  assert.equal(member(m.id).tier, before.tier, '等级不得变化')
  assert.equal(member(m.id).card_status, 'none', '持卡状态不得变化')

  // 系统异常不缓存幂等键：修复后同键可安全重试
  const retry = M.purchaseCard(m.id, card.id, 't-tx-1')
  assert.equal(retry.ok, true, '同键重试应成功执行')
})

test('冻结会员：不可购卡、不享预约折扣；解冻恢复', () => {
  const m = M.enrollMember({ name: '冻结辛', source: 'manual' })
  M.setMemberStatus(m.id, 'freeze')
  const card = cardOf('月卡')
  const r1 = M.purchaseCard(m.id, card.id, 't-freeze-1')
  assert.equal(r1.ok, false)
  assert.equal(r1.code, 'MBR_FROZEN')
  const slot = db.prepare("SELECT * FROM reservation_slots WHERE scope='entry' AND day=1 AND hour=11").get()
  const r2 = RSV.createReservation({ scope: 'entry', slotId: slot.id, qty: 1, memberCode: member(m.id).code, requestId: 't-freeze-2' })
  assert.equal(r2.ok, false)
  M.setMemberStatus(m.id, 'unfreeze')
  const r3 = M.purchaseCard(m.id, card.id, 't-freeze-3')
  assert.equal(r3.ok, true)
})
