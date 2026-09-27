<script setup>
import { ref, computed, watch } from 'vue'
import { useParkStore, newRequestId } from '@/store/park'

const store = useParkStore()

// 后端错误转「中文提示〔错误码 · 请求号〕」
function errText(r, fallback = '操作失败，请稍后重试') {
  if (r?.ok) return ''
  const msg = r?.msg || fallback
  const tag = r?.code ? `〔${r.code}${r.reqId ? ' · ' + r.reqId : ''}〕` : ''
  return msg + tag
}

const stats = computed(() => store.memberStats)
const tiers = computed(() => store.memberTiers.length ? store.memberTiers : [
  { level: 0, name: '普通会员', icon: '⚪', growth: 0, ticketDisc: 1, rideDisc: 1, vendorDisc: 1, pointsRate: 1, lateRefundFree: false },
  { level: 1, name: '白银会员', icon: '🥈', growth: 800, ticketDisc: 0.95, rideDisc: 0.95, vendorDisc: 0.97, pointsRate: 1.2, lateRefundFree: false },
  { level: 2, name: '黄金会员', icon: '🥇', growth: 3000, ticketDisc: 0.9, rideDisc: 0.85, vendorDisc: 0.92, pointsRate: 1.5, lateRefundFree: true },
  { level: 3, name: '黑钻会员', icon: '💎', growth: 8000, ticketDisc: 0.8, rideDisc: 0.75, vendorDisc: 0.85, pointsRate: 2, lateRefundFree: true }
])
const pct = v => Math.round(v * 100) + '%'

// ============ 页签 ============
const tabs = [
  { k: 'list', label: '会员名录' },
  { k: 'cards', label: '售卡与权益' },
  { k: 'logs', label: '积分与流水' }
]
const tab = ref('list')

// ============ 页签一：会员名录 ============
const fStatus = ref('')
const fTier = ref('')
const fQ = ref('')
const filtered = computed(() => store.members.filter(m => {
  if (fStatus.value && m.status !== fStatus.value) return false
  if (fTier.value !== '' && m.tier !== +fTier.value) return false
  if (fQ.value) {
    const q = fQ.value.trim()
    if (!m.code.includes(q) && !m.name.includes(q) && !(m.phone || '').includes(q)) return false
  }
  return true
}))

// 前台登记
const enrollOpen = ref(false)
const enrollName = ref('')
const enrollPhone = ref('')
const enrollMsg = ref(null)
async function doEnroll() {
  if (!enrollName.value.trim()) { enrollMsg.value = { text: '请填写会员姓名', ok: false }; return }
  const r = await store.enrollMember({ name: enrollName.value.trim(), phone: enrollPhone.value.trim() })
  enrollMsg.value = r?.ok
    ? { text: `登记成功，会员号 ${r.code}`, ok: true }
    : { text: errText(r, '登记失败'), ok: false }
  if (r?.ok) { enrollName.value = ''; enrollPhone.value = '' }
}

// 行级操作防重
const rowBusy = ref({})
async function rowOp(id, fn) {
  if (rowBusy.value[id]) return
  rowBusy.value[id] = true
  try { await fn() } finally { rowBusy.value[id] = false }
}
const flashes = ref({})
function flash(id, msg, ok) { flashes.value[id] = { msg, ok: !!ok } }

// 购卡（行内展开）
const buyOpen = ref({})
const buyCard = ref({})
const buyReqId = ref({})
function toggleBuy(m) {
  buyOpen.value[m.id] = !buyOpen.value[m.id]
  if (buyOpen.value[m.id]) { buyCard.value[m.id] = 0; buyReqId.value[m.id] = newRequestId() }
}
async function doBuy(m) {
  const cid = +buyCard.value[m.id]
  if (!cid) return
  await rowOp(m.id, async () => {
    const r = await store.purchaseCard(m.id, cid, buyReqId.value[m.id])
    flash(m.id, r?.ok ? `✓ 售卡成功 ${r.code}，有效期至第 ${r.end_day} 天` : errText(r, '售卡失败'), r?.ok)
    if (r?.ok) { buyOpen.value[m.id] = false; buyReqId.value[m.id] = newRequestId() }
  })
}

// 退卡
async function doRefundCard(m) {
  await rowOp(m.id, async () => {
    const r = await store.refundCard(m.id, newRequestId())
    flash(m.id, r?.ok ? `已退卡，退款 ¥${r.refund}，积分清零 ${r.cleared} 分` : errText(r, '退卡失败'), r?.ok)
  })
}

// 调分（行内展开）
const adjOpen = ref({})
const adjDelta = ref({})
const adjReason = ref({})
const adjReqId = ref({})
function toggleAdj(m) {
  adjOpen.value[m.id] = !adjOpen.value[m.id]
  if (adjOpen.value[m.id]) { adjDelta.value[m.id] = 100; adjReason.value[m.id] = ''; adjReqId.value[m.id] = newRequestId() }
}
async function doAdjust(m) {
  const d = Math.round(+adjDelta.value[m.id])
  if (!d) return
  await rowOp(m.id, async () => {
    const r = await store.adjustPoints(m.id, d, adjReason.value[m.id] || '', adjReqId.value[m.id])
    flash(m.id, r?.ok ? `✓ 调账完成，当前积分 ${r.balance}` : errText(r, '调账失败'), r?.ok)
    if (r?.ok) { adjOpen.value[m.id] = false; adjReqId.value[m.id] = newRequestId() }
  })
}

async function toggleFreeze(m) {
  await rowOp(m.id, async () => {
    const r = await store.setMemberStatus(m.id, m.status === 'frozen' ? 'unfreeze' : 'freeze')
    flash(m.id, r?.ok ? (m.status === 'frozen' ? '已解冻' : '已冻结') : errText(r, '操作失败'), r?.ok)
  })
}

// 详情
const detail = ref(null)
const detailOrders = ref([])
const detailPoints = ref([])
const detailTiers = ref([])
const POINT_TYPE = {
  consume: '消费积分', card_bonus: '开卡赠分', redeem: '积分抵现',
  clawback: '退款扣回', compensate: '退款补偿', adjust: '运营调账', clear: '退卡清零'
}
const TIER_REASON = {
  enroll: '注册入会', upgrade: '成长升级', downgrade: '成长降级',
  card_grant: '购卡授予', card_expire: '卡到期', card_refund: '退卡'
}
async function openDetail(m) {
  const d = await store.memberDetail(m.id)
  if (d?.member) {
    detail.value = d.member
    detailOrders.value = d.orders || []
    detailPoints.value = d.pointsLogs || []
    detailTiers.value = d.tierLogs || []
  }
}
function closeDetail() { detail.value = null }

// ============ 页签二：售卡与权益 ============
const editCard = ref({})   // cardId -> { price, bonus_points }
function beginCardEdit(c) { editCard.value[c.id] = { price: c.price, bonus_points: c.bonus_points } }
async function saveCard(c) {
  const e = editCard.value[c.id]
  if (!e) return
  const r = await store.updateMemberCard(c.id, { price: Math.round(+e.price), bonus_points: Math.round(+e.bonus_points) })
  if (r?.ok) editCard.value[c.id] = null
}
async function toggleCardActive(c) {
  await store.updateMemberCard(c.id, { active: c.active ? 0 : 1 })
}
const newCard = ref({ name: '', price: 588, valid_days: 60, grant_tier: 1, bonus_points: 300 })
const cardMsg = ref(null)
async function doCreateCard() {
  const r = await store.createMemberCard({ ...newCard.value })
  cardMsg.value = r?.ok ? { text: '卡种已上架', ok: true } : { text: errText(r, '创建失败'), ok: false }
  if (r?.ok) newCard.value = { name: '', price: 588, valid_days: 60, grant_tier: 1, bonus_points: 300 }
}

// ============ 页签三：积分与流水 ============
const logs = ref({ points: [], tiers: [] })
async function loadLogs() { logs.value = await store.memberLogs() || { points: [], tiers: [] } }
watch(tab, t => { if (t === 'logs') loadLogs() })
watch(() => store.clock.tick, () => { if (tab.value === 'logs') loadLogs() })
const memberFin = computed(() => store.finance.filter(f => ['会员卡', '会员退款', '会员优惠', '积分抵现'].includes(f.label)).slice(-30).reverse())

const tierOf = lv => tiers.value.find(t => t.level === lv) || tiers.value[0]
const growthPct = m => m.next_tier_growth ? Math.min(100, Math.round(m.growth / m.next_tier_growth * 100)) : 100
</script>

<template>
  <div class="mbr">
    <!-- 顶部指标 -->
    <div class="stat-grid">
      <div class="card stat"><span>👥</span><b>{{ stats.total }}</b><em>在册会员（正常 {{ stats.active }} / 冻结 {{ stats.frozen }}）</em></div>
      <div class="card stat"><span>💳</span><b>{{ stats.cardHolders }}</b><em>持卡会员</em></div>
      <div class="card stat"><span>✨</span><b>+{{ stats.todayNew }}</b><em>今日新增会员</em></div>
      <div class="card stat"><span>🧾</span><b class="money">{{ stats.cardRevToday.toLocaleString() }}</b><em>今日售卡 {{ stats.cardsToday }} 张</em></div>
      <div class="card stat"><span>🪙</span><b>{{ stats.pointsLive.toLocaleString() }}</b><em>积分池（发 {{ stats.pointsOut.toLocaleString() }} / 销 {{ stats.pointsUsed.toLocaleString() }}）</em></div>
      <div class="card stat" :class="{ alert: stats.active > stats.staffCapacity }">
        <span>💁</span><b :class="{ neg: stats.active > stats.staffCapacity }">{{ stats.staffCount }} 人</b>
        <em>客服专员 · 承载 {{ stats.staffCapacity }} 会员</em>
      </div>
    </div>

    <!-- 今日动态 -->
    <div class="card today" v-if="stats.activity">
      <b>今日会员动态</b>
      <span>新注册 <b>{{ stats.activity.enrolled }}</b></span>
      <span>售卡 <b>{{ stats.activity.cardsSold }}</b> 张</span>
      <span>到店 <b>{{ stats.activity.visits }}</b> 人次</span>
      <span>会员消费 <b class="money">¥{{ Math.round(stats.activity.spend).toLocaleString() }}</b></span>
      <span>折让成本 <b class="money neg">¥{{ Math.round(stats.activity.discountCost).toLocaleString() }}</b></span>
      <span>积分抵现 <b class="money neg">¥{{ Math.round(stats.activity.redeemValue).toLocaleString() }}</b></span>
    </div>

    <div class="tabs card">
      <button v-for="t in tabs" :key="t.k" :class="{ on: tab === t.k }" @click="tab = t.k">{{ t.label }}</button>
      <span class="muted hint" v-if="tab === 'list'">会员购卡、调分、冻结与退卡；等级随成长值与持卡权益自动流转</span>
      <span class="muted hint" v-else-if="tab === 'cards'">卡种商品配置与等级权益一览</span>
      <span class="muted hint" v-else>积分台账、等级流转轨迹与会员相关财务入账</span>
    </div>

    <!-- ============ 会员名录 ============ -->
    <template v-if="tab === 'list'">
      <div class="filters card">
        <div class="seg">
          <button :class="{ on: fStatus === '' }" @click="fStatus = ''">全部</button>
          <button :class="{ on: fStatus === 'active' }" @click="fStatus = 'active'">正常</button>
          <button :class="{ on: fStatus === 'frozen' }" @click="fStatus = 'frozen'">冻结</button>
        </div>
        <select v-model="fTier">
          <option value="">全部等级</option>
          <option v-for="t in tiers" :key="t.level" :value="t.level">{{ t.icon }} {{ t.name }}</option>
        </select>
        <input v-model="fQ" placeholder="搜索会员号 / 姓名 / 手机号" class="q" />
        <button class="primary" @click="enrollOpen = !enrollOpen">＋ 前台登记</button>
      </div>

      <div class="card enroll" v-if="enrollOpen">
        <input v-model="enrollName" placeholder="会员姓名（必填）" maxlength="12" />
        <input v-model="enrollPhone" placeholder="手机号（选填）" maxlength="20" />
        <button class="succ" @click="doEnroll">确认登记</button>
        <em v-if="enrollMsg" :class="{ ok: enrollMsg.ok, err: !enrollMsg.ok }" class="flash">{{ enrollMsg.text }}</em>
      </div>

      <div class="table card">
        <div class="thead">
          <span>会员</span><span>等级</span><span>积分</span><span>成长值</span><span>持卡</span><span>累计消费</span><span>状态</span><span>操作</span>
        </div>
        <template v-for="m in filtered" :key="m.id">
          <div class="trow" :class="{ frozen: m.status === 'frozen' }">
            <span><b>{{ m.code }}</b><em class="muted"> {{ m.name }}</em></span>
            <span><i class="tier">{{ m.tier_icon }}</i>{{ m.tier_name }}</span>
            <span class="nums">{{ m.points.toLocaleString() }}</span>
            <span>
              <div class="hb"><i :style="{ width: growthPct(m) + '%' }"></i></div>
              {{ m.growth.toLocaleString() }}<em class="muted" v-if="m.next_tier"> / {{ m.next_tier_growth.toLocaleString() }}</em>
            </span>
            <span>
              <template v-if="m.card_valid">💳 {{ m.card_name }}<em class="muted"> 剩 {{ m.card_remain_days }} 天</em></template>
              <em v-else class="muted">{{ m.card_status === 'expired' ? '卡已到期' : m.card_status === 'refunded' ? '已退卡' : '未持卡' }}</em>
            </span>
            <span class="money">¥{{ m.total_spend.toLocaleString() }}</span>
            <span><i class="dot" :class="m.status === 'active' ? 'on' : 'off'"></i>{{ m.status === 'active' ? '正常' : '冻结' }}</span>
            <span class="ops">
              <button class="ghost" :disabled="rowBusy[m.id]" @click="toggleBuy(m)">购卡</button>
              <button class="ghost" :disabled="rowBusy[m.id]" @click="toggleAdj(m)">调分</button>
              <button class="ghost" :disabled="rowBusy[m.id]" @click="toggleFreeze(m)">{{ m.status === 'frozen' ? '解冻' : '冻结' }}</button>
              <button class="ghost danger" v-if="m.card_valid" :disabled="rowBusy[m.id]" @click="doRefundCard(m)">退卡</button>
              <button class="ghost" @click="openDetail(m)">详情</button>
            </span>
          </div>
          <div class="inline-box" v-if="buyOpen[m.id]">
            <select v-model.number="buyCard[m.id]">
              <option :value="0" disabled>选择卡种…</option>
              <option v-for="c in store.memberCards.filter(x => x.active)" :key="c.id" :value="c.id">
                {{ c.name }} · ¥{{ c.price }} · {{ c.valid_days }}天 · 享{{ tierOf(c.grant_tier).name }} · 赠{{ c.bonus_points }}分
              </option>
            </select>
            <button class="primary" :disabled="!buyCard[m.id] || rowBusy[m.id]" @click="doBuy(m)">确认售卡（{{ m.card_valid ? '续卡顺延' : '新购' }}）</button>
          </div>
          <div class="inline-box" v-if="adjOpen[m.id]">
            <input type="number" v-model.number="adjDelta[m.id]" step="50" placeholder="正=补发 负=扣减" style="width:150px" />
            <input v-model="adjReason[m.id]" placeholder="调账原因（选填）" maxlength="30" />
            <button class="primary" :disabled="!adjDelta[m.id] || rowBusy[m.id]" @click="doAdjust(m)">确认调账</button>
          </div>
          <em v-if="flashes[m.id]" class="flash" :class="{ ok: flashes[m.id].ok, err: !flashes[m.id].ok }">{{ flashes[m.id].msg }}</em>
        </template>
        <div class="muted empty" v-if="!filtered.length">暂无符合条件的会员。</div>
      </div>
    </template>

    <!-- ============ 售卡与权益 ============ -->
    <template v-if="tab === 'cards'">
      <div class="card">
        <h3>💳 卡种商品（售卡收入实时入账「会员卡」科目）</h3>
        <div class="table">
          <div class="thead cards">
            <span>卡种</span><span>售价</span><span>有效期</span><span>授予等级</span><span>开卡赠分</span><span>状态</span><span>操作</span>
          </div>
          <div class="trow cards" v-for="c in store.memberCards" :key="c.id">
            <span><b>{{ c.name }}</b></span>
            <span>
              <template v-if="editCard[c.id]"><input type="number" class="mini-in" v-model.number="editCard[c.id].price" min="1" /></template>
              <template v-else class="money">¥{{ c.price.toLocaleString() }}</template>
            </span>
            <span>{{ c.valid_days }} 天</span>
            <span>{{ tierOf(c.grant_tier).icon }} {{ tierOf(c.grant_tier).name }}</span>
            <span>
              <template v-if="editCard[c.id]"><input type="number" class="mini-in" v-model.number="editCard[c.id].bonus_points" min="0" step="50" /></template>
              <template v-else>{{ c.bonus_points }} 分</template>
            </span>
            <span><i class="dot" :class="c.active ? 'on' : 'off'"></i>{{ c.active ? '在售' : '下架' }}</span>
            <span class="ops">
              <template v-if="editCard[c.id]">
                <button class="succ" @click="saveCard(c)">保存</button>
                <button class="ghost" @click="editCard[c.id] = null">取消</button>
              </template>
              <template v-else>
                <button class="ghost" @click="beginCardEdit(c)">调价</button>
                <button class="ghost" :class="{ danger: c.active }" @click="toggleCardActive(c)">{{ c.active ? '下架' : '上架' }}</button>
              </template>
            </span>
          </div>
        </div>
        <div class="newcard">
          <b>新增卡种</b>
          <input v-model="newCard.name" placeholder="名称" maxlength="12" style="width:110px" />
          <label>售价 <input type="number" v-model.number="newCard.price" min="1" style="width:90px" /></label>
          <label>有效天 <input type="number" v-model.number="newCard.valid_days" min="1" style="width:80px" /></label>
          <label>授予
            <select v-model.number="newCard.grant_tier">
              <option v-for="t in tiers.filter(x => x.level > 0)" :key="t.level" :value="t.level">{{ t.name }}</option>
            </select>
          </label>
          <label>赠分 <input type="number" v-model.number="newCard.bonus_points" min="0" step="50" style="width:90px" /></label>
          <button class="primary" :disabled="!newCard.name" @click="doCreateCard">上架</button>
          <em v-if="cardMsg" class="flash" :class="{ ok: cardMsg.ok, err: !cardMsg.ok }">{{ cardMsg.text }}</em>
        </div>
      </div>

      <div class="card">
        <h3>🎖️ 等级权益（成长值每日衰减 3%，等级 = max(成长等级, 持卡等级)）</h3>
        <div class="table">
          <div class="thead tiers">
            <span>等级</span><span>成长值门槛</span><span>门票</span><span>游乐</span><span>商铺</span><span>积分倍率</span><span>退票权益</span>
          </div>
          <div class="trow tiers" v-for="t in tiers" :key="t.level">
            <span><i class="tier">{{ t.icon }}</i><b>{{ t.name }}</b></span>
            <span>{{ t.growth.toLocaleString() }}</span>
            <span>{{ pct(t.ticketDisc) }}</span>
            <span>{{ pct(t.rideDisc) }}</span>
            <span>{{ pct(t.vendorDisc) }}</span>
            <span>×{{ t.pointsRate }}</span>
            <span>{{ t.lateRefundFree ? '当日取消免手续费' : '—' }}</span>
          </div>
        </div>
        <div class="muted tips">
          💡 消费 ¥1 = 1 成长值 + 1 积分（×等级倍率）；积分可抵现（100 分抵 ¥10，单笔上限 30%）；
          园方原因退款自动补偿 200 积分；退卡按剩余天数比例退款（20% 手续费）并清零积分。
        </div>
      </div>
    </template>

    <!-- ============ 积分与流水 ============ -->
    <template v-if="tab === 'logs'">
      <div class="logs-grid">
        <div class="card">
          <h3>🪙 积分台账</h3>
          <div class="loglist">
            <div class="plog" v-for="l in logs.points" :key="'p' + l.id">
              <span class="badge">{{ POINT_TYPE[l.type] || l.type }}</span>
              <b>{{ l.member_code }}</b>
              <em class="delta" :class="l.delta > 0 ? 'pos' : 'neg'">{{ l.delta > 0 ? '+' : '' }}{{ l.delta }}</em>
              <em class="muted">余 {{ l.balance }}</em>
              <em class="muted day">第{{ l.day }}天</em>
              <p class="muted">{{ l.note }}</p>
            </div>
            <div class="muted empty" v-if="!logs.points.length">暂无积分流水。</div>
          </div>
        </div>
        <div class="card">
          <h3>🎖️ 等级流转</h3>
          <div class="loglist">
            <div class="plog" v-for="l in logs.tiers" :key="'t' + l.id">
              <span class="badge tierb">{{ TIER_REASON[l.reason] || l.reason }}</span>
              <b>{{ l.member_code }}</b>
              <em>{{ tierOf(l.from_tier).icon }}{{ tierOf(l.from_tier).name }} → {{ tierOf(l.to_tier).icon }}{{ tierOf(l.to_tier).name }}</em>
              <em class="muted day">第{{ l.day }}天</em>
              <p class="muted">{{ l.note }}</p>
            </div>
            <div class="muted empty" v-if="!logs.tiers.length">暂无等级流转记录。</div>
          </div>
        </div>
        <div class="card">
          <h3>📒 会员财务入账</h3>
          <div class="loglist">
            <div class="plog" v-for="f in memberFin" :key="'f' + f.id">
              <span class="badge finb">{{ f.label }}</span>
              <em class="delta" :class="f.amount >= 0 ? 'pos' : 'neg'">{{ f.amount >= 0 ? '+' : '' }}¥{{ f.amount.toLocaleString() }}</em>
              <em class="muted day">第{{ f.day }}天</em>
              <p class="muted">{{ f.detail }}</p>
            </div>
            <div class="muted empty" v-if="!memberFin.length">暂无会员相关财务流水。</div>
          </div>
        </div>
      </div>
    </template>

    <!-- 会员详情 -->
    <div class="mask" v-if="detail" @click.self="closeDetail">
      <div class="dialog card">
        <h3>{{ detail.tier_icon }} {{ detail.code }} · {{ detail.name }}
          <span class="badge">{{ detail.tier_name }}</span>
          <button class="ghost x" @click="closeDetail">✕</button>
        </h3>
        <p class="d-meta muted">
          积分 <b>{{ detail.points.toLocaleString() }}</b> · 成长值 {{ detail.growth.toLocaleString() }} ·
          累计消费 ¥{{ detail.total_spend.toLocaleString() }} · 第 {{ detail.join_day }} 天入会
          <template v-if="detail.card_valid"> · 💳 {{ detail.card_name }}（第 {{ detail.card_expire_day }} 天到期）</template>
        </p>
        <h4>购卡订单</h4>
        <div class="logs" v-if="detailOrders.length">
          <div v-for="o in detailOrders" :key="o.id" class="log">
            <span class="ldot"></span>
            <b>{{ o.code }} · {{ o.card_name }}</b>
            <em class="muted">¥{{ o.price }} · 第{{ o.start_day }}~{{ o.end_day }}天 · {{ o.status === 'refunded' ? `已退 ¥${o.refund_amount}` : '有效' }}</em>
          </div>
        </div>
        <p class="muted" v-else>暂无购卡记录。</p>
        <h4>积分流水</h4>
        <div class="logs" v-if="detailPoints.length">
          <div v-for="l in detailPoints" :key="l.id" class="log">
            <span class="ldot"></span>
            <b>{{ POINT_TYPE[l.type] || l.type }}</b>
            <em class="delta" :class="l.delta > 0 ? 'pos' : 'neg'">{{ l.delta > 0 ? '+' : '' }}{{ l.delta }}</em>
            <em class="muted">第{{ l.day }}天 · 余 {{ l.balance }}</em>
            <p class="muted">{{ l.note }}</p>
          </div>
        </div>
        <p class="muted" v-else>暂无积分流水。</p>
        <h4>等级流转</h4>
        <div class="logs" v-if="detailTiers.length">
          <div v-for="l in detailTiers" :key="l.id" class="log">
            <span class="ldot"></span>
            <b>{{ TIER_REASON[l.reason] || l.reason }}</b>
            <em class="muted">第{{ l.day }}天 · {{ tierOf(l.from_tier).name }} → {{ tierOf(l.to_tier).name }}</em>
            <p class="muted">{{ l.note }}</p>
          </div>
        </div>
        <p class="muted" v-else>暂无流转记录。</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mbr { display: flex; flex-direction: column; gap: 14px; }
.stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; }
.stat { display: flex; flex-direction: column; gap: 3px; }
.stat span { font-size: 20px; }
.stat b { font-size: 22px; }
.stat em { font-style: normal; color: var(--muted); font-size: 12px; }
.stat.alert { border-color: rgba(255,107,107,.55); }
.neg { color: var(--red); }

.today { display: flex; gap: 18px; align-items: center; flex-wrap: wrap; font-size: 13px; color: var(--muted); }
.today b:first-child { color: var(--text); }
.today span b { color: var(--text); }

.tabs { display: flex; align-items: center; gap: 8px; }
.tabs button { padding: 7px 18px; }
.tabs button.on { border-color: var(--accent); background: rgba(255,107,107,.14); color: var(--accent); }
.tabs .hint { margin-left: 8px; font-size: 12px; }

.filters { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.filters .seg { display: flex; gap: 6px; }
.filters .seg button.on { border-color: var(--accent); background: rgba(255,107,107,.14); color: var(--accent); }
.filters .q { width: 200px; }
.filters .primary { margin-left: auto; }
.enroll { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }

.table { padding: 6px; overflow-x: auto; }
.thead, .trow { display: grid; grid-template-columns: 1.2fr 1fr .8fr 1.2fr 1.2fr .9fr .7fr 2.2fr; gap: 8px; align-items: center; padding: 10px 12px; font-size: 13px; min-width: 1080px; }
.thead { color: var(--muted); border-bottom: 1px solid var(--border); font-size: 12px; }
.trow { border-bottom: 1px solid var(--border); }
.trow.frozen { opacity: .55; }
.thead.cards, .trow.cards { grid-template-columns: 1fr 1fr .9fr 1.1fr 1fr .8fr 1.2fr; min-width: 760px; }
.thead.tiers, .trow.tiers { grid-template-columns: 1.2fr 1fr .8fr .8fr .8fr .9fr 1.4fr; min-width: 760px; }
.nums { font-variant-numeric: tabular-nums; }
.tier { font-style: normal; margin-right: 4px; }
.hb { width: 70px; height: 7px; background: var(--panel2); border-radius: 4px; overflow: hidden; display: inline-block; margin-right: 6px; vertical-align: middle; }
.hb i { display: block; height: 100%; background: var(--accent2); }
.dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 5px; }
.dot.on { background: var(--green); }
.dot.off { background: var(--red); }
.ops { display: flex; gap: 4px; flex-wrap: wrap; }
.ops button { font-size: 11px; padding: 4px 8px; }
.ops .danger { color: var(--red); border-color: rgba(255,107,107,.4); }
.mini-in { width: 80px; padding: 4px 6px; }
.empty { padding: 16px; text-align: center; }

.inline-box { display: flex; gap: 8px; align-items: center; padding: 8px 14px; border-bottom: 1px solid var(--border); background: var(--panel2); flex-wrap: wrap; }
.inline-box select { max-width: 420px; }
.flash { font-style: normal; font-size: 12.5px; padding: 4px 14px; display: block; }
.flash.ok { color: var(--green); }
.flash.err { color: var(--red); }

.newcard { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-top: 12px; padding-top: 12px; border-top: 1px dashed var(--border); font-size: 13px; color: var(--muted); }
.newcard label { display: flex; gap: 4px; align-items: center; }
.tips { margin-top: 12px; font-size: 12px; line-height: 1.7; }

.logs-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 14px; align-items: start; }
.loglist { display: flex; flex-direction: column; max-height: 480px; overflow-y: auto; }
.plog { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 8px 4px; border-bottom: 1px solid var(--border); font-size: 12.5px; }
.plog p { width: 100%; font-size: 11.5px; margin: 2px 0 0; }
.badge { font-size: 11px; padding: 2px 9px; border-radius: 20px; border: 1px solid var(--border); background: var(--panel2); color: var(--muted); }
.tierb { color: var(--accent2); border-color: rgba(255,209,102,.4); }
.finb { color: var(--blue); border-color: rgba(102,166,255,.4); }
.delta { font-style: normal; font-weight: 700; }
.delta.pos { color: var(--green); }
.delta.neg { color: var(--red); }
.day { font-size: 11px; margin-left: auto; }

.mask { position: fixed; inset: 0; background: rgba(5,8,18,.65); display: flex; align-items: center; justify-content: center; z-index: 50; padding: 20px; }
.dialog { width: min(620px, 100%); max-height: 86vh; overflow-y: auto; }
.dialog .x { margin-left: auto; }
.d-meta { font-size: 13px; margin: 8px 0; }
.dialog h4 { margin: 16px 0 10px; font-size: 13px; }
.logs { display: flex; flex-direction: column; }
.log { position: relative; padding: 0 0 14px 20px; border-left: 2px solid var(--border); margin-left: 5px; }
.log:last-child { border-left-color: transparent; padding-bottom: 0; }
.log .ldot { position: absolute; left: -7px; top: 2px; width: 12px; height: 12px; border-radius: 50%; background: var(--accent); border: 2px solid var(--bg); }
.log b { font-size: 13px; margin-right: 8px; }
.log em { font-size: 11px; font-style: normal; }
.log p { font-size: 12px; margin-top: 3px; }
</style>
