import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import * as PIXI from 'pixi.js'
import type { Live2DModel as Live2DModelInstance } from 'pixi-live2d-display/cubism4'

// ---------- AI 悬浮球的 Live2D 小组件:渲染 Miku 模型,替代原星星图标 ----------
// 模型文件在 public/live2d/ 下按皮肤分目录(classic → miku/、sakura → miku-sakura/),
// 含全部表情/动作文件;版权模型,仅本地使用,勿提交/分发。
// 交互约定:点击/拖动都由外层 .ai-fab 按钮统一处理,App 通过 window 事件通知这里做反馈:
//   miku:tap(detail.clientY 点击纵坐标,按位置分区反应) / miku:dragstart / miku:dragend /
//   miku:express(AI 回复轻表情) / miku:celebrate(完成待办/打卡庆祝) / miku:thinking(on) /
//   miku:speak(ms 口型时长) / miku:murmur(请求外层冒一句碎碎念) / miku:play / miku:qq。
// 这里只负责渲染与"活着"的部分:眨眼 + 呼吸内置,眼睛/头部跟随鼠标,点击分区反馈+弹跳,
// 拖动身体轻摆,等 AI 回复时慢速晃,说话口型,闲置自娱彩蛋,夜晚(21–06 点)困困模式。
// 初始化失败(缺 Core、无 WebGL、模型损坏)时回调 onFailed,由外层回退为星星图标。

const CORE_URL = '/live2d/live2dcubismcore.min.js'

// ---------- 皮肤注册表 ----------
// 两套模型同一骨架同一参数方案(QQ 人=Param131/136、水印关闭=Param137、脸红=130、
// 圈圈=125、前倾=132),但「手势位」只有经典有:Param133/134/135 在经典上是
// 大葱/唱歌/比心(cdi3 里就是这么标的)。樱花模型是作者未完成的改版——删了 134/135,
// 把 133 改标「哭」,并且**133 不再用来掏出手中物**:它只掀开 4 块米粒大的眼周图元,
// 大葱部件(Part63,樱花自己的贴图里画的仍是那根葱)变成恒隐藏、没有任何参数能掀开。
// 于是樱花皮肤既没有手部动作,也没有能看见的舞蹈,皮肤配置里两者都为空。
// 作者那支 哭.exp3.json(Param133=1)不足以单独成按钮,但不该丢掉:它在樱花皮肤上
// 改走「可叠加表情 + 表情补偿」的路子(见 emotes.哭),这样按钮按下去真看得见变化。
//
// 参数级证据(2026-10-05 直接读两套 moc3 实测,各 141 参数、Cubism Core 5.1):
//   经典 Param133=1 → 71 块图元透明度翻转:隐藏默认手姿 31 块、显示大葱部件 40 块
//     (ArtMesh260~294),该簇由 Param16/45/63 驱动 → 拿葱舞看得见
//   樱花 Param133=1 → 只有 ArtMesh357/358/361/362 四块显隐(眼周,屏幕上约 5×4 px,
//     合计约 61px²);大葱簇 ArtMesh260~294 在樱花上恒为 opacity 0,
//     133/16/45/63/89/90 都不改变它,而 Scene1 的曲线只碰 Param16/45/63/126/70/89/90
//     → 舞蹈动作全部落在看不见的图元上(唯一有面积分量的是 Param70:隐藏 32 块
//     「发光/发光电路/电路板」装饰,约 12.5k px²,渲染序靠后,多为被裙子挡住的发光件)
//   樱花上真正能动、看得见的只有:QQ人 131(位移 350px)、前倾 132(51.9px)、
//     脸红 130(1405px²)、圈圈 125(223px²)、水印 137,以及头九轴/呼吸/眨眼/口型
// 换皮肤由父级换 key 重挂本组件完成,skin prop 只在挂载时读一次(见 skinConfRef)
export type MikuSkin = 'classic' | 'sakura'

/**
 * 可叠加表情的一个参数档:激活时每帧写 on,关闭瞬间补 off(缺省 0)。mode 决定写法:
 *   set(缺省)= 直接赋值,写在 internalModel.update 尾部;
 *   min = 只封顶,取 min(当前值, on)——眼皮开度专用:眨眼系统每帧绝对写眼皮参数,
 *         所以这类参数必须改在 coreModel.update 之前写(见那里的注释),否则当帧无效
 */
export interface EmoteParam {
  id: string
  on: number
  off?: number
  mode?: 'set' | 'min'
}

// 哭时的眼皮开度上限(0=闭 1=睁):留一点缝,像忍着泪
const CRY_EYE_MAX = 0.7

// 「哭」的泪珠增强:樱花模型自带 4 颗泪珠图元(Param133 掀开,ArtMesh357/358/361/362),
// 但画布上只有 5×4 px,而模型侧改不了(作者只发布了运行时文件,没有 .cmo3 工程,
// 于是在「核心算完网格之后、提交 GPU 之前」直接改这几块图元在 WASM 堆里的顶点:
// 按质心整体放大 + 沿脸颊下滑。core 的 drawables.vertexPositions[i] 是堆上的
// Float32Array 视图(实测源码为 new Float32Array(HEAPF32.buffer, off, n)),可直接写;
// 渲染器每帧从同一块内存取顶点,而核心每帧都会用基础网格重算 → 写出去的值不会逐帧
// 累积,停止「哭」后下一帧自动复位
const TEAR_SCALE = 1.75
/** 滴落节奏:停顿 → 平滑下滑;两眼错开半拍 */
const TEAR_DRIP_PERIOD_MS = 2600
const TEAR_DRIP_SLIDE_MS = 900
/** 滑落距离(模型单位):0.055 ≈ 养成页画布 17px */
const TEAR_DRIP_DROP = 0.055
/** 每只眼睛的泪珠图元名(左眼 / 右眼),按名字解析成索引 */
const TEAR_DRAWABLE_NAMES: readonly (readonly string[])[] = [
  ['ArtMesh357', 'ArtMesh358'],
  ['ArtMesh361', 'ArtMesh362'],
]

interface SkinConf {
  modelUrl: string
  /** 注册进 model settings 的表情:Name(运行时引用名) → 模型目录里的 exp3 文件 */
  expressions: readonly { name: string; file: string }[]
  /** 随机轻表情池(点击/AI 回复/闲置/庆祝) */
  light: readonly string[]
  /** 可叠加表情 → 专属参数档(update 尾部每帧写,见 EmoteParam) */
  emotes: Record<string, readonly EmoteParam[]>
  /** 舞蹈保留动作:pin 名(菜单勾选值)+ 舞蹈期间的表情(把手中的葱亮出来);
   * 动作文件用各皮肤目录自带的 Scene1;null = 该皮肤没有能看见的舞蹈 */
  dance: { pin: string; expression: string } | null
  /** 手部骨架保留动作(菜单/养成页动作组渲染用);talkMs 仅唱歌用 */
  handActions: readonly { name: string; talkMs?: number }[]
}

export const MIKU_SKINS: Record<MikuSkin, SkinConf> = {
  classic: {
    modelUrl: '/live2d/miku/miku.model3.json',
    expressions: [
      { name: '比心', file: '比心.exp3.json' },
      { name: '脸红', file: '脸红.exp3.json' },
      { name: '圈圈', file: '圈圈.exp3.json' },
      { name: '唱歌', file: '唱歌.exp3.json' },
      { name: '葱', file: '葱.exp3.json' },
      { name: 'QQ人', file: 'QQ人.exp3.json' },
      { name: '前倾', file: '前倾.exp3.json' },
    ],
    light: ['比心', '脸红', '圈圈'],
    emotes: {
      脸红: [{ id: 'Param130', on: 1 }],
      圈圈: [{ id: 'Param125', on: 1 }],
      前倾: [{ id: 'Param132', on: 1 }],
    },
    dance: { pin: '拿葱舞', expression: '葱' },
    handActions: [{ name: '比心' }, { name: '唱歌', talkMs: 3200 }],
  },
  sakura: {
    modelUrl: '/live2d/miku-sakura/樱花miku.model3.json',
    // 注册的表情限于这套骨架真做得到、也看得见的:作者自己的 VTS 热点只有
    // QQ人/前倾/圈圈/水印/脸红/哭 六个,其中 哭 走下面的可叠加表情层(emotes.哭),
    // 不在这里注册成独立 exp3——那支文件只写 Param133=1,单独用等于点了没反应
    expressions: [
      { name: '脸红', file: '脸红.exp3.json' },
      { name: '圈圈', file: '圈圈.exp3.json' },
      { name: 'QQ人', file: 'QQ人.exp3.json' },
      { name: '前倾', file: '前倾.exp3.json' },
    ],
    light: ['脸红', '圈圈'],
    emotes: {
      脸红: [{ id: 'Param130', on: 1 }],
      圈圈: [{ id: 'Param125', on: 1 }],
      前倾: [{ id: 'Param132', on: 1 }],
      // 哭:照写作者 哭.exp3.json 的 Param133=1(泪珠档),但它在这套骨架上只掀开
      // 4 块共约 61px² 的眼周小图元,单靠它等于没反应——所以再叠一层这台骨架真能动、
      // 也看得见的表情补偿:眯眼(min 封顶,眨眼仍能闭得更小)、抿嘴、抬右眉
      // (左眉 ParamBrowLY/LAngle/LForm 在这套模型上没有绑定,写也无害故不写)、
      // 低头(绝对写 ParamAngleY;眼神跟随是加法叠加,不会被夺走,点头时由点头压过)。
      // 全部只碰模型自有参数,不改任何模型文件
      哭: [
        { id: 'Param133', on: 1 },
        { id: 'ParamEyeLOpen', on: CRY_EYE_MAX, off: 1, mode: 'min' },
        { id: 'ParamEyeROpen', on: CRY_EYE_MAX, off: 1, mode: 'min' },
        { id: 'ParamMouthForm', on: -0.9 },
        { id: 'ParamBrowRY', on: 0.8 },
        { id: 'ParamAngleY', on: -12 },
      ],
    },
    // 无舞蹈、无手部动作:见文件头「参数级证据」——Scene1 与 133 在这套模型上
    // 都只作用在恒隐藏的图元上,挂出去就是两个点了没反应的按钮
    dance: null,
    handActions: [],
  },
}

/** 跨皮肤表情代偿:目标皮肤没有该表情时换成最接近的可用表情(比心→脸红);
 * 返回 null = 没有代偿(唱歌手势、樱花皮肤的手部动作),调用方只保留口型等其余反应 */
export function resolveExpression(skin: MikuSkin, name: string): string | null {
  const conf = MIKU_SKINS[skin]
  if (conf.expressions.some((e) => e.name === name)) return name
  if (name === '比心') return '脸红'
  return null
}

/**
 * 写一个可叠加表情的参数档。三处调用:切换瞬间(激活/关闭各一次)与 update 尾部每帧。
 * 参数不存在时 setParameterValueById 是无害空写,效果自动退化
 */
function applyEmoteParam(core: ParamWriter & ParamReader, p: EmoteParam, active: boolean) {
  try {
    if (!active) {
      core.setParameterValueById(p.id, p.off ?? 0)
      return
    }
    if (p.mode === 'min')
      core.setParameterValueById(p.id, Math.min(core.getParameterValueById(p.id), p.on))
    else core.setParameterValueById(p.id, p.on)
  } catch {
    // 模型可能在写入前被销毁,忽略
  }
}

const EXPRESSION_MS = 2800

// 分区触摸:点击纵坐标换算成舞台相对高度,头顶摸摸/脸颊戳戳/身体挠痒痒各有反应
const ZONE_FACE = 0.38
const ZONE_BODY = 0.6
// 挠痒痒扭动时长 / 连击彩蛋:900ms 内连点 5 次 → 比心
const WIGGLE_MS = 700
const COMBO_WINDOW_MS = 900
const COMBO_N = 5
// 庆祝冷却:连续完成多件事时不叠表情
const CELEBRATE_COOLDOWN_MS = 1500

// 闲置彩蛋:多久没动静开始自娱 / 彩蛋之间的最短间隔 / 拿葱舞时长(模型自带动作 2.67s/轮)
const IDLE_MS = 40_000
const IDLE_COOLDOWN_MS = 70_000
const DANCE_MS = 2667 * 2 + 300

// 夜晚困困模式(21:00–06:00):眼皮开度封顶——眨眼与表情照常工作(闭眼不受影响),
// 但睁眼幅度最多到 NIGHT_EYE_MAX,呈现半睁困意。用 min 钳制而非乘算:
// 眨眼系统只在眨眼瞬间写参数,间隙不写,乘算会逐帧复利把眼睛越乘越闭
const NIGHT_EYE_MAX = 0.55
function isNightHour() {
  const h = new Date().getHours()
  return h >= 21 || h < 6
}

// 点头 tween 时长(ParamAngleY 在此区间正弦两摆后归零)
const NOD_MS = 700

// 舞台尺寸:竖向容器,模型底部居中站立(悬浮球默认 170×230;养成页传更大的尺寸复用同一套逻辑)
const STAGE_W = 170
const STAGE_H = 230

// QQ 人形态(Param131/136)的 morph 实测(按 230 高的舞台标定):角色缩至约 37%,
// 头顶钉在原画布顶部,脚底升高约 140 舞台像素、视觉中心右偏约 26px。变身时把模型
// 平移回去,让 Q 版小人站回容器底沿、居中于盒子;其他舞台高度按比例缩放偏移量
const QQ_SHIFT_REF_H = 230
const qqShiftFor = (h: number) => ({ x: (-26 * h) / QQ_SHIFT_REF_H, y: (140 * h) / QQ_SHIFT_REF_H })

// 互动事件名(与 App 解耦,通过 window CustomEvent 通信)
export const MIKU_EXPRESS_EVENT = 'miku:express'
export const MIKU_TAP_EVENT = 'miku:tap'
export const MIKU_DRAG_START_EVENT = 'miku:dragstart'
export const MIKU_DRAG_END_EVENT = 'miku:dragend'
/** 舞台内左右拖动(detail {dx} 增量,养成页):平移支点目标,钳制在画布两侧留边内 */
export const MIKU_SLIDE_EVENT = 'miku:slide'
export const MIKU_QQ_EVENT = 'miku:qq'
/** 指定表演:detail 为 { expression?: 名称, talkMs?: 口型时长 ms } 或 { dance?: true }(右键菜单「动作」用) */
export const MIKU_PLAY_EVENT = 'miku:play'
/** 完成待办/习惯打卡庆祝(各面板派发,带 1.5s 冷却) */
export const MIKU_CELEBRATE_EVENT = 'miku:celebrate'
/** AI 思考中开关(detail { on: boolean }) */
export const MIKU_THINKING_EVENT = 'miku:thinking'
/** 开口说话(detail { ms: number } 口型持续时长) */
export const MIKU_SPEAK_EVENT = 'miku:speak'
/** 闲置碎碎念:请求外层(App)按当前数据冒一句气泡 */
export const MIKU_MURMUR_EVENT = 'miku:murmur'
/** 连击点按广播(detail {count, done})——养成页的连击浮标用 */
export const MIKU_COMBO_EVENT = 'miku:combo'
/** 无冷却的轻庆祝(detail 无):弹跳 + 随机轻表情,小游戏连击反馈用 */
export const MIKU_CHEER_EVENT = 'miku:cheer'
/** 点头回应(无 detail):头部 ParamAngleY 短促两摆 */
export const MIKU_NOD_EVENT = 'miku:nod'
/**
 * 可叠加表情开关(detail {name} 切换 / {clearA} 全清):脸红/圈圈/前倾各占独立参数,
 * 可同时生效(两皮肤同集,见 MIKU_SKINS[*].emotes)
 */
export const MIKU_EMOTE_EVENT = 'miku:emote'
/** 眯眼害羞(detail {ms}):EyeL/R_Squint 保持一段时间 */
export const MIKU_SQUINT_EVENT = 'miku:squint'

declare global {
  interface Window {
    Live2DCubismCore?: unknown
  }
}

type ParamWriter = { setParameterValueById(id: string, value: number): void }
type ParamReader = { getParameterValueById(id: string): number }

/** 完成待办/习惯打卡后让 Miku 庆祝一下(未启用 Live2D 时无监听方,无副作用);
 * label 可选:养成页的气泡会播报具体事项名 */
export function celebrateMiku(label?: string) {
  window.dispatchEvent(
    new CustomEvent(MIKU_CELEBRATE_EVENT, label ? { detail: { label } } : undefined),
  )
}

// Cubism Core 是外部运行时脚本,必须在插件模块导入前就位(该模块加载时即检查 window.Live2DCubismCore),
// 因此这里动态注入脚本,再动态 import 插件;失败时组件回退为图标,不影响应用其余部分
let coreLoading: Promise<void> | null = null
let libFailed = false
function ensureCubismCore(): Promise<void> {
  if (window.Live2DCubismCore) return Promise.resolve()
  coreLoading ??= new Promise<void>((resolve, reject) => {
    const el = document.createElement('script')
    el.src = CORE_URL
    el.onload = () => resolve()
    el.onerror = () => {
      coreLoading = null
      reject(new Error('Cubism Core 加载失败'))
    }
    document.head.appendChild(el)
  })
  return coreLoading
}

function loadLive2DPlugin(): Promise<typeof import('pixi-live2d-display/cubism4')> {
  return import('pixi-live2d-display/cubism4')
}

// 同页双舞台(悬浮球 + 养成页)各有一个 WebGL 上下文,而 pixi-live2d-display 的
// CubismShader_WebGL 是模块级单例:着色器程序缓存在「第一次编译它的那个上下文」上,
// 且 Live2DModel 的 glContextID 只跟踪各自的 renderer——养成页模型首次渲染会把全局
// 缓存刷成养成页上下文的程序,悬浮球模型感知不到这次交换,继续拿别人的程序画自己的
// 上下文,GL_INVALID_OPERATION,模型从此空白(实测:进过养成页后悬浮球永久空帧)。
// 这里在 _render 外层按「全局最近一次 Live2D 渲染的上下文」检测切换,强制失配模型
// 走库自带的 updateWebGLContext(glContextID 置 -1)重建本上下文的着色器/蒙版缓存。
// 每次跨页切换各重编译一次着色器(毫秒级),换回哪个页面都能立刻恢复显示。
let crossContextPatched = false
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function patchCrossContextShaderCache(Live2DModelCtor: { prototype: any }) {
  if (crossContextPatched) return
  crossContextPatched = true
  const proto = Live2DModelCtor.prototype
  const origRender: (renderer: { CONTEXT_UID: number }) => void = proto._render
  let lastUid: number | null = null
  proto._render = function (renderer: { CONTEXT_UID: number }) {
    if (lastUid !== null && lastUid !== renderer.CONTEXT_UID) {
      ;(this as unknown as { glContextID: number }).glContextID = -1
    }
    lastUid = renderer.CONTEXT_UID
    // deltaTime 由共享 ticker 持续累积、只在渲染时被消费:舞台隐藏(渲染停摆)越久,
    // 恢复后首帧灌给动作/物理系统的 dt 越大,会造成模型瞬移/物理爆开。钳到单帧
    // 量级;正常掉帧(≤200ms)不受影响
    const m = this as unknown as { deltaTime: number }
    if (m.deltaTime > 200) m.deltaTime = 16.7
    origRender.call(this, renderer)
  }
}

// 拉取模型设置。model3.json 本身没有声明表情/动作,这里在内存里把当前皮肤的表情文件
// 与拿葱/跳舞动作(Scene1,即 VTS 动作按键)注册进去(不改动磁盘上的任何模型文件);
// 水印表情刻意不注册,水印参数在模型加载后直接按作者预留档位关闭。
async function buildModelSettings(skin: MikuSkin): Promise<Record<string, unknown>> {
  const conf = MIKU_SKINS[skin]
  const res = await fetch(conf.modelUrl)
  if (!res.ok) throw new Error(`模型设置加载失败: ${res.status}`)
  const json = (await res.json()) as Record<string, any>
  // settings 需要携带自身 url,用于解析相对路径的 moc/贴图/表情/动作引用
  json.url = conf.modelUrl
  json.FileReferences.Expressions = conf.expressions.map((e) => ({ Name: e.name, File: e.file }))
  if (conf.dance) json.FileReferences.Motions = { Dance: [{ File: 'Scene1.motion3.json' }] }
  return json
}

interface Props {
  onReady?: () => void
  onFailed?: () => void
  /** QQ 人形态开关变化时回调(外层据此缩小按钮盒与拖动钳制范围) */
  onQQChange?: (on: boolean) => void
  /** 眼神/头部跟随鼠标(右键菜单「显示」可关) */
  eyeFollow?: boolean
  /** 闲置彩蛋(右键菜单「显示」可关) */
  idleEnabled?: boolean
  /** 舞台像素尺寸;悬浮球用默认,养成页传大尺寸 */
  width?: number
  height?: number
  /** fab = 悬浮球内(page 变体仅影响类名,定位由外层容器负责) */
  variant?: 'fab' | 'page'
  /**
   * 皮肤(classic 原版 / sakura 樱花):只在挂载时读一次;切换皮肤由父级换 key
   * 重挂本组件(与网格自愈同一机制),不做热更新
   */
  skin?: MikuSkin
  /**
   * 当前保留动作(App 的 mikuAction 单真源):重挂(换皮肤/网格自愈/配置自愈)后
   * 据此在新模型上恢复,undefined = 不参与同步。不传的话,重挂后按钮还亮着而
   * 新模型上没有任何动作,表现为「点了没反应」的假象
   */
  pinnedAction?: string | null
  /**
   * 可叠加表情的当前状态(App 单真源,与右键菜单/养成页按钮共享)。
   * 事件(MIKU_EMOTE_EVENT)只在点击那一刻生效,而舞台随时可能重挂(换皮肤/
   * 网格自愈/HMR)——重挂后新模型上一个参数都没写,UI 却还亮着,表现为
   * 「勾着却没效果」。这里按 prop 对账,重挂后自动把激活的表情补写回去。
   * undefined = 不参与同步
   */
  emoteOn?: Record<string, boolean>
  /**
   * 全局 QQ 人形态开关(App 的 mikuQQ,单真源)。同页双舞台 + 右键菜单/养成页
   * 动作组共用这个状态:任何一处切换后,另一个舞台(哪怕正 display:none 隐藏)
   * 也必须跟随,否则换页会出现「小按钮盒里站着普通立绘」的错位——立绘大半溢出
   * 可点区域(pointer-events:none),怎么双击都点不到。undefined = 不参与同步
   */
  qqOn?: boolean
  /**
   * 渲染主开关:父组件知道本舞台何时被 display:none 隐藏(切页/悬浮球退场),
   * 直接据此启停渲染循环。不能只靠 IntersectionObserver:它的回调在「浏览器绘制
   * 帧」时才生成,display:none 恢复后偶发不派发(实测画布冻结成隐藏前最后一帧,
   * 此后双击变 QQ 等一切视觉变化全部无效);React 状态提交是确定性的,切页瞬间
   * 生效。IO 仍保留,兜「挂载着但被滚动出视口」的情形
   */
  visible?: boolean
  /**
   * 模型网格失能报警:pixi-live2d-display 在同页第二只模型出现后,会让先创建的
   * 那只模型的参数→网格形变管线静默失效(参数照常写、update 照常跑、顶点纹丝
   * 不动,WASM 层原因未明)。变 Q 后若轮廓没有按预期收缩即判定中招,父级应重挂
   * 本组件(换 key)换一只新模型自愈
   */
  onModelDead?: () => void
}

/** 通过 ref 暴露给外层的能力:查询当前形态的嘴部锚点(画布内逻辑坐标) */
export type MikuStageApi = {
  /** QQ 形态时返回 Q 版嘴部位置,普通形态返回站姿嘴部位置;未就绪返回 null */
  getMouthAnchor: () => { x: number; y: number } | null
}

function MikuStageInner(
  {
    onReady,
    onFailed,
    onQQChange,
    eyeFollow = true,
    idleEnabled = true,
    width = STAGE_W,
    height = STAGE_H,
    variant = 'fab',
    skin = 'classic',
    pinnedAction,
    qqOn,
    emoteOn,
    visible = true,
    onModelDead,
  }: Props,
  ref: React.Ref<MikuStageApi>,
) {
  // 外部 QQ 状态的渲染期镜像:init 完成时模型可能晚于状态变化才就绪,就绪对齐要读最新值
  const qqOnRef = useRef<boolean | undefined>(qqOn)
  qqOnRef.current = qqOn
  // 皮肤配置镜像:仅挂载时读一次(换皮肤必然伴随父级换 key 重挂,本 ref 不热更新)
  const skinConfRef = useRef(MIKU_SKINS[skin])
  // 配置身份自愈:HMR/发版后模块常量换了新对象身份,而 Fast Refresh 会保留本实例
  // 与已加载的旧模型(init effect 不重跑)——旧模型上注册的还是旧表情名,新 UI 派发
  // 的新表情名(如经典皮肤的「比心」)在它上面查不到,全部静默失效,表现为「点了没反应」。
  // 检测到配置对象换身份即触发父级换 key 重挂,换上新配置加载的模型(每次配置
  // 变更只触发一次,重挂后 ref 由新模块重建,身份自然一致)
  useEffect(() => {
    if (skinConfRef.current !== MIKU_SKINS[skin]) {
      skinConfRef.current = MIKU_SKINS[skin]
      onModelDeadRef.current?.()
    }
  })
  // 当前皮肤的随机轻表情(点击反应/AI 回复/闲置/庆祝共用)
  const pickLight = () => {
    const pool = skinConfRef.current.light
    return pool[Math.floor(Math.random() * pool.length)]
  }
  // 当前皮肤下的可用表情:不存在时按代偿表换(见 resolveExpression);
  // 仍无(如唱歌手势无代偿)则退回圈圈,保证调用方永远拿到可用的表情名
  const skinExpr = (name: string): string => resolveExpression(skin, name) ?? '圈圈'
  const hostRef = useRef<HTMLDivElement>(null)
  const modelRef = useRef<Live2DModelInstance | null>(null)
  const readyRef = useRef(false)
  // 就绪镜像:驱动 CSS 登场动画(模型挂上舞台的一瞬 canvas 从透明空帧变为有内容,
  // 加类重触发 keyframes,两个舞台变体共用)
  const [ready, setReady] = useState(false)
  // 舞台几何(QQ 偏移按舞台高度比例缩放):挂载后不变,供初始化与事件处理器闭包使用
  const qqShift = qqShiftFor(height)
  const basePosNormal = { x: width / 2, y: height }
  const basePosQQ = { x: width / 2 + qqShift.x, y: height + qqShift.y }
  // 特效状态:适配缩放基准 / 弹跳起点 / 拖动摆动开关与回正标记 / 表情复位定时器 / 闲置彩蛋截止时刻
  const baseScaleRef = useRef(1)
  const bounceAtRef = useRef<number | null>(null)
  const draggingRef = useRef(false)
  const swayDirtyRef = useRef(false)
  const expressionTimerRef = useRef<number | undefined>(undefined)
  const idleUntilRef = useRef(0)
  // QQ 人形态:双击切换的持续形态,参数直接驱动(与表情系统互不干扰),qqLevel 做 ~0.2s 快速过渡
  const qqTargetRef = useRef(0)
  const qqLevelRef = useRef(0)
  // 闲置彩蛋开关镜像(供 interval 闭包读取最新值)
  const idleOnRef = useRef(idleEnabled)
  // 模型脚底支点(舞台坐标):QQ 形态下平移,变身时逐帧滑向目标,避免跳变
  const basePosRef = useRef({ ...basePosNormal })
  const basePosTargetRef = useRef({ ...basePosNormal })
  // 等 AI 回复的慢速轻晃 / 挠痒痒扭动截止时刻 / 说话口型截止时刻 / 口型进行中标记
  const thinkingRef = useRef(false)
  const wiggleUntilRef = useRef(0)
  const talkUntilRef = useRef(0)
  const talkingRef = useRef(false)
  // 夜晚困困模式 / 连击点按计数 / 上次庆祝时刻 / 夜晚是否已生效(退出时恢复眼皮基础值)
  const nightRef = useRef(isNightHour())
  const comboCountRef = useRef(0)
  const comboLastAtRef = useRef(0)
  const celebrateAtRef = useRef(0)
  const nightWasRef = useRef(false)
  // 点头/眯眼 tween:截止时刻与「进行中→结束需补写归零」标记(与夜晚眼皮同套路)
  const nodUntilRef = useRef(0)
  const nodWasRef = useRef(false)
  const squintUntilRef = useRef(0)
  const squintWasRef = useRef(false)
  // 保留动作(右键菜单「动作」选的表情):本会话内一直保持;期间的点击反应/AI 回复
  // 表情/闲置彩蛋都是临时客串,结束后回到她。null = 无保留(临时表情结束即复原)。
  // 值为皮肤舞蹈的 pin 名时 = 循环舞蹈(见 MIKU_SKINS[*].dance)。刷新页面回默认待机,不做跨刷新记忆
  const pinnedRef = useRef<string | null>(null)
  // 临时表情/一次性动作的截止时刻:掏葱、比心等姿势会改变可见剪影(比如大葱
  // 伸向一侧),居中自检以「居中站姿」为测量前提,姿势期间介入会把姿势当偏移
  // 修掉——喂食后整个人被平移,姿势结束再被拉回,表现为一喂就漂
  const expressionUntilRef = useRef(0)
  // 循环拿葱舞的重启定时器(独立于表情复原定时器:临时表情不会打断舞蹈循环)
  const danceLoopTimerRef = useRef<number | undefined>(undefined)
  // PIXI Application 引用:IntersectionObserver 据此暂停/恢复渲染(离屏不烧 GPU)
  const appRef = useRef<PIXI.Application | null>(null)
  const onScreenRef = useRef(true)
  // 可叠加表情的激活集合:每帧在 update 尾部写各自的专属参数(互不冲突)
  const emoteOnRef = useRef<Set<string>>(new Set())
  // 切换瞬间把某个表情的参数档写到位(每帧那份在 update 包装里);事件与 prop 对账共用
  const writeEmoteParams = (name: string, active: boolean) => {
    const core = modelRef.current?.internalModel.coreModel as (ParamWriter & ParamReader) | null
    if (core) for (const p of skinConfRef.current.emotes[name] ?? []) applyEmoteParam(core, p, active)
  }
  // 表情状态对账:舞台重挂(换皮肤/网格自愈/HMR)后新模型上什么都没写,而 UI 还亮着,
  // 表现为「勾着却没效果」。按 App 传进来的单真源把激活集合补齐/清掉
  useEffect(() => {
    if (emoteOn === undefined) return
    const want = new Set(Object.keys(emoteOn).filter((k) => emoteOn[k]))
    for (const name of [...emoteOnRef.current]) {
      if (!want.has(name)) {
        emoteOnRef.current.delete(name)
        writeEmoteParams(name, false)
      }
    }
    for (const name of want) {
      if (!emoteOnRef.current.has(name)) {
        emoteOnRef.current.add(name)
        writeEmoteParams(name, true)
      }
    }
    // writeEmoteParams 只读 ref,行为不随渲染变化
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [emoteOn])
  // 视觉居中修正量(px):可见形象中心相对画布中线的偏移。普通形态出场 800ms 后
  // 实测一次;QQ 形态轮廓不同,首次变形完成后再实测一次并缓存,之后切换直接复用
  const normalOffsetRef = useRef(0)
  const qqOffsetRef = useRef<number | null>(null)
  // QQ 形态的纵向落地补偿:变形后角色实际脚底位置随模型缩放变化,标定常量
  // (qqShiftFor 按 230 高标定)在大/小舞台上对不准,实测轮廓底边到画布底的间隙
  // 后把人精确沉到容器底沿
  const qqOffsetYRef = useRef(0)
  // page 变体的周期居中自检定时器,卸载时清理
  const centeringTimerRef = useRef<number | null>(null)
  // 舞台是否可见:挂在 display:none 子树(如切走后的养成页/隐藏的悬浮球)里时应
  // 完全静默——不响应 window 互动事件、不做闲置彩蛋,否则看不见的她会在背后偷偷演
  const stageVisible = () => !!hostRef.current && hostRef.current.getClientRects().length > 0
  // 用户在舞台内左右拖动累计的水平位移(px):居中自检与 QQ 形态切换都要以此为基准,
  // 否则会把她「修正」回画布中线,撤销用户的摆放
  const slideXRef = useRef(0)
  // 拖动边界:按「可见剪影」半宽计算——网格 bound 比可见头发窄很多(头发动画
  // 超出 bind-pose,实测 bound 151px vs 剪影 ~250px),按 bound 钳制她仍会被
  // 画布边缘裁切;剪影宽度量一次按形态缓存,QQ 形态剪影约缩到四成
  const silHalfRef = useRef<{ normal: number | null; qq: number | null }>({
    normal: null,
    qq: null,
  })
  // 影子跟随:上一帧写给 CSS 变量的值(变化超 0.5px 才写,避免每帧样式写入)
  const shadowRelRef = useRef<number | null>(null)
  const slideBounds = (allowScan: boolean) => {
    const model = modelRef.current
    let half = model ? model.width / 2 : width * 0.35
    const key = qqTargetRef.current === 1 ? 'qq' : 'normal'
    const cached = silHalfRef.current[key]
    if (cached != null) {
      half = cached
    } else if (allowScan && readyRef.current && stageVisible()) {
      const sil = scanSilhouette()
      if (sil) {
        half = (sil.maxX - sil.minX) / 2 / (appRef.current?.renderer.resolution || 1)
        silHalfRef.current[key] = half
      }
    }
    return { min: half + 4, max: width - half - 4 }
  }

  // 回读当前画布帧,统计「不透明像素」的包围盒(设备像素,GL 坐标系 y 向上)。
  // Live2D 的 anchor 居中按全部网格取中,已关闭的水印、未启用的 QQ 形态部件等
  // 不可见网格会把边界撑歪,肉眼可见的身体因此偏在一侧;需要 PIXI 开
  // preserveDrawingBuffer 才读得到像素。失败返回 null
  const scanSilhouette = useCallback((): { minX: number; maxX: number; minY: number; maxY: number } | null => {
    try {
      const app = appRef.current
      const cv = app?.view as HTMLCanvasElement | undefined
      if (!app || !cv) return null
      const gl = (cv.getContext('webgl2') || cv.getContext('webgl')) as WebGLRenderingContext | null
      if (!gl) return null
      const bw = gl.drawingBufferWidth
      const bh = gl.drawingBufferHeight
      // readPixels 读的是「当前绑定的 FBO」:Live2D 的遮罩/滤镜 pass 可能把非默认
      // FBO 留在 GL 状态里,不绑回默认帧缓冲就会读到 stale 纹理(全零或错位内容),
      // 三帧采样还会「高度一致」地通过校验,把垃圾修正锁死——必须显式绑回再读
      const prevFbo = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      const px = new Uint8Array(bw * bh * 4)
      gl.readPixels(0, 0, bw, bh, gl.RGBA, gl.UNSIGNED_BYTE, px)
      gl.bindFramebuffer(gl.FRAMEBUFFER, prevFbo)
      let minX = -1
      let maxX = -1
      let minGy = -1
      let maxGy = -1
      // 每列必须扫完全高:不能「遇到首个不透明像素就 break」——人形直立时双腿
      // 间隙那列扫到的首个像素是裙摆下缘,maxGy 会被记成裙摆而非头顶,
      // getMouthAnchor 的嘴部纵坐标随之落到腰上(喂食食物飞进肚子的根因)。
      // minGy(脚底)/minX/maxX 语义不受影响;开销只多出身体各列的上半段遍历
      for (let x = 0; x < bw; x += 2) {
        for (let y = 0; y < bh; y += 4) {
          if (px[(y * bw + x) * 4 + 3] > 10) {
            if (minX === -1) minX = x
            maxX = x
            if (minGy === -1 || y < minGy) minGy = y
            if (maxGy === -1 || y > maxGy) maxGy = y
          }
        }
      }
      if (minX < 0 || maxX <= minX) return null
      return { minX, maxX, minY: minGy, maxY: maxGy }
    } catch {
      return null
    }
  }, [])

  // 回读当前画布帧,返回把「不透明像素轮廓」移到画布中线所需的 x 偏移(逻辑 px)。
  // 失败返回 null,调用方保持原状
  const measureCenterDx = useCallback((): number | null => {
    const app = appRef.current
    if (!app) return null
    const sil = scanSilhouette()
    if (!sil) return null
    // PIXI 6 的 renderer.width 是设备像素(dpr>1 时 = 逻辑宽 × resolution),
    // 逻辑宽在 renderer.screen.width——用错的话 dpr=1.5 时中点被抬高半块画布,
    // 自检平衡点落在真实右偏 ~170px 处,喂食表情一动剪影就越过阈值继续右推
    const cx = app.renderer.screen.width / 2
    const dx = cx - (sil.minX + sil.maxX) / 2 / app.renderer.resolution
    return Math.abs(dx) < 0.5 ? 0 : dx
  }, [scanSilhouette])

  // 外层(养成页喂食动画)查询当前形态嘴部在画布内的位置:
  // 实时回读轮廓包围盒,普通形态嘴约在身形 23% 高度,Q 版(大头)约 38%
  useImperativeHandle(
    ref,
    () => ({
      getMouthAnchor: () => {
        if (!readyRef.current || !stageVisible()) return null
        const app = appRef.current
        if (!app) return null
        const sil = scanSilhouette()
        if (!sil) return null
        const res = app.renderer.resolution
        // 逻辑高取 renderer.screen.height(PIXI 6 的 renderer.height 是设备像素,
        // 见 measureCenterDx 注释);GL 坐标 y 向上,翻转成 CSS 纵向
        const H = app.renderer.screen.height
        const top = H - sil.maxY / res
        const bottom = H - sil.minY / res
        const x = (sil.minX + sil.maxX) / 2 / res
        const y = top + (bottom - top) * (qqTargetRef.current === 1 ? 0.38 : 0.23)
        return { x, y }
      },
    }),
    [scanSilhouette],
  )

  // QQ 形态进出:参数档 + 支点平移 + 弹跳;notify=false 表示由外部状态(App 的
  // qqOn)驱动,不回写 onQQChange。隐藏中的实例也要跟随开关(只更新内部状态,
  // 画面等恢复渲染后自然收敛):两个舞台与右键菜单/养成页动作组共用同一个全局
  // 开关,任何一处切换后另一处都必须一致,否则换页会出现「小按钮盒里站着普通
  // 立绘」的错位——立绘大半溢出可点区域(pointer-events:none),怎么双击都点不到
  // 测量轮次号:每次进入 QQ 形态递增,旧测量循环据「epoch 不再相等」整体作废
  const qqMeasureEpochRef = useRef(0)
  // 变 Q 前的轮廓宽度(CSS px,可见时才采集):供「网格失能」检测对比。
  // 宽度比高度可靠——沉底的死亡形态被画布裁掉下半身,可见高度反而变矮,
  // 宽度却仍是普通姿态的原值;健康的 morph 宽度收到约 40%,死亡则基本不变
  const preMorphWidthRef = useRef<number | null>(null)
  const meshDeadReportedRef = useRef(false)
  const onModelDeadRef = useRef(onModelDead)
  onModelDeadRef.current = onModelDead
  const applyQQ = (entering: boolean, notify: boolean) => {
    qqTargetRef.current = entering ? 1 : 0
    const base = entering ? basePosQQ : basePosNormal
    const off = entering ? qqOffsetRef.current ?? 0 : normalOffsetRef.current
    // 用户拖动的水平位移跟随形态:换形态后她站的地方不变(按剪影重新钳制;
    // applyQQ 时刻的形态尚未变形,扫描留给 onSlide,这里用缓存或保守的 bound)。
    // 钳制后的实际位移回写 slideXRef 与 CSS 变量,影子(住在本组件宿主里)同步
    const b = slideBounds(false)
    const slideX = Math.min(
      Math.max(slideXRef.current, b.min - (base.x + off)),
      b.max - (base.x + off),
    )
    slideXRef.current = slideX
    basePosTargetRef.current = {
      x: base.x + off + slideX,
      y: base.y + (entering ? qqOffsetYRef.current : 0),
    }
    bounceAtRef.current = performance.now()
    if (entering) {
      // 可见时才采得到:scanSilhouette 读的是已渲染像素,刚进 QQ 的支点平移
      // 尚未渲染,此刻轮廓即「普通形态」的宽度基准
      const sil = stageVisible() ? scanSilhouette() : null
      preMorphWidthRef.current = sil
        ? (sil.maxX - sil.minX) / (appRef.current?.renderer.resolution || 1)
        : null
    }
    if (notify) onQQChange?.(entering)
    if (entering) scheduleQQMeasure(++qqMeasureEpochRef.current)
  }
  const applyQQRef = useRef(applyQQ)
  applyQQRef.current = applyQQ

  // 变形完成(约 200ms)且庆祝弹跳结束(0.5s)后实测 Q 版轮廓:水平居中偏移与
  // 「脚底到画布底的间隙」都按实测修正——x 补偿按悬浮球标定,大舞台上按比例放大
  // 后仍会偏;y 的固定标定量同样会漂。实测缓存后再次切换直接复用,不再滑动
  const scheduleQQMeasure = (epoch: number, attempt = 0) => {
    window.setTimeout(() => {
      // 卸载后 appRef 已置空,scanSilhouette 返回 null 自然跳过;单帧回读有撞上
      // 半帧的风险,修正量超画布宽 20% 视为垃圾放弃
      if (qqTargetRef.current !== 1) return
      if (epoch !== qqMeasureEpochRef.current) return // 期间又切了一次形态:本轮作废
      if (!stageVisible()) return // 隐藏画布读到的是陈旧帧,量出的全是垃圾
      // 变形 tween 与庆祝弹跳只在渲染帧上推进:两者任一未归位,说明形态还没定格
      // (RAF 被节流/遮挡时 600ms 内可能一帧都没画),此刻回读到的是瞬态帧,
      // 量出的间隙会把 qqOffsetY 永久污染(缓存整个会话,之后每次变 Q 都沉底
      // ——实测 RAF 1.5s 一帧时必现)。未定格就重试;始终定格不了(渲染彻底
      // 停摆)则放弃,保留标定默认值,好过写入垃圾
      if (qqLevelRef.current !== 1 || bounceAtRef.current !== null) {
        // 60 次预算:RAF 被节流到 1.5s/帧时 settle 约需 20s;渲染彻底停摆则
        // 放弃并保留标定默认值,好过写入垃圾
        if (attempt < 60) scheduleQQMeasure(epoch, attempt + 1)
        return
      }
      const app = appRef.current
      const sil = scanSilhouette()
      if (!app || !sil) return
      // 网格失能检测:参数档已定格在 1,轮廓宽度却几乎没收缩——参数→网格管线
      // 已被同页第二只模型毒害(机制见 props.onModelDead 注释;用宽度不用高度,
      // 因为沉底的死亡形态会被画布裁掉下半身,高度反而变矮)。上报父级重挂自愈;
      // 死模型上量出的偏移全是垃圾,本轮到此为止
      const silWidth = (sil.maxX - sil.minX) / app.renderer.resolution
      if (
        !meshDeadReportedRef.current &&
        preMorphWidthRef.current !== null &&
        silWidth > preMorphWidthRef.current * 0.75
      ) {
        meshDeadReportedRef.current = true
        onModelDeadRef.current?.()
        return
      }
      const dx = measureCenterDx()
      // 用户拖动过(slideX ≠ 0)时,轮廓中心的水平偏差包含用户位移,不再叠加进
      // 形态偏移缓存(否则拖动位移会被当成标定误差双倍写回);纵向与拖动无关照常。
      // 钳制按 15% 舞台高(与首次居中同一把尺,理由见 applyCentering 处注释):
      // 合法修正随模型缩放 ∝ 舞台高,按画布宽算会把垃圾放行空间放大 3 倍
      if (slideXRef.current === 0 && dx && Math.abs(dx) <= height * 0.15) {
        qqOffsetRef.current = (qqOffsetRef.current ?? 0) + dx
        basePosTargetRef.current.x += dx
      }
      // 纵向自愈:GL 坐标 y 向上,sil.minY = 最低不透明像素(脚底)离画布底的间隙
      // ——理论上应为 0(站回容器底沿),不为零说明标定量在这个舞台尺寸上漂了,
      // 按间隙下沉;正确时为零不动作。量级钳制兜底瞬态
      const gapY = sil.minY / app.renderer.resolution
      if (gapY > 1.5 && gapY < height * 0.5) {
        qqOffsetYRef.current += gapY
        basePosTargetRef.current.y += gapY
      }
    }, attempt === 0 ? 600 : 1000)
  }

  // 临时表情结束后的复原:有保留动作则回到她(舞蹈保留回舞蹈表情),否则完全复位
  const restoreExpressionSafe = () => {
    try {
      const model = modelRef.current
      const pinned = pinnedRef.current
      const dance = skinConfRef.current.dance
      if (model && pinned) {
        Promise.resolve(
          model.expression(dance && pinned === dance.pin ? dance.expression : pinned),
        ).catch(() => undefined)
        return
      }
      model?.internalModel.motionManager.expressionManager?.resetExpression()
    } catch {
      // 模型可能在复位前被销毁,忽略
    }
  }

  const stopMotionSafe = () => {
    try {
      modelRef.current?.internalModel.motionManager.stopAllMotions()
    } catch {
      // 同上,销毁后调用忽略
    }
  }

  // 设表情并在几秒后复原(复原 = 回到保留动作)。所有表情类互动共用,避免复位定时器互相打架
  const showExpression = (name: string, ms = EXPRESSION_MS) => {
    const model = modelRef.current
    if (!model || !readyRef.current) return
    Promise.resolve(model.expression(name)).catch(() => undefined)
    expressionUntilRef.current = performance.now() + ms
    window.clearTimeout(expressionTimerRef.current)
    expressionTimerRef.current = window.setTimeout(restoreExpressionSafe, ms)
  }

  // 保留动作:立即应用且不设复原定时器(一直保持,直到换成别的或取消)。
  // 舞蹈是动作不是表情:交给循环重启器
  const pinAction = (name: string) => {
    pinnedRef.current = name
    window.clearTimeout(expressionTimerRef.current)
    if (skinConfRef.current.dance?.pin === name) {
      kickDanceLoop()
      return
    }
    const model = modelRef.current
    if (model && readyRef.current) Promise.resolve(model.expression(name)).catch(() => undefined)
  }

  // 循环舞蹈:跳完 DANCE_MS 后只要还保留着舞蹈就再起一轮
  // (定时器独立于表情复原定时器,临时表情客串不会打断循环)
  const kickDanceLoop = () => {
    window.clearTimeout(danceLoopTimerRef.current)
    doDance()
    danceLoopTimerRef.current = window.setTimeout(() => {
      if (pinnedRef.current === skinConfRef.current.dance?.pin) kickDanceLoop()
    }, DANCE_MS)
  }

  // 取消保留动作:回到默认状态(舞蹈保留还要停掉动作与循环定时器)
  const unpinAction = () => {
    pinnedRef.current = null
    window.clearTimeout(expressionTimerRef.current)
    window.clearTimeout(danceLoopTimerRef.current)
    try {
      modelRef.current?.internalModel.motionManager.stopAllMotions()
      modelRef.current?.internalModel.motionManager.expressionManager?.resetExpression()
    } catch {
      // 忽略销毁后调用
    }
  }

  // 闲置彩蛋之一:眼神瞟向随机远处(focus 越界会被钳成侧目),用户一动鼠标自然回正
  const glanceAway = () => {
    const model = modelRef.current
    const r = hostRef.current?.getBoundingClientRect()
    if (!model || !r) return
    const x = r.left + width / 2 + (Math.random() * 2 - 1) * 900
    const y = r.top + height / 2 + (Math.random() * 2 - 1) * 700
    model.focus(x, y)
  }

  // 闲置彩蛋之一:跳一段舞(模型自带 Scene1 动作),失败降级为普通表情
  const doDance = () => {
    const model = modelRef.current
    const dance = skinConfRef.current.dance
    if (!model || !readyRef.current || !dance) return
    const fallback = () => showExpression('圈圈', 3000)
    Promise.resolve(model.expression(dance.expression)).catch(fallback)
    Promise.resolve(model.motion('Dance', 0))
      .then((ok) => {
        if (!ok) fallback()
      })
      .catch(fallback)
    idleUntilRef.current = Date.now() + DANCE_MS
    expressionUntilRef.current = performance.now() + DANCE_MS
    window.clearTimeout(expressionTimerRef.current)
    expressionTimerRef.current = window.setTimeout(restoreExpressionSafe, DANCE_MS)
  }

  const doIdleAct = () => {
    const roll = Math.random()
    if (roll < 0.3) {
      showExpression(pickLight(), 3200)
      idleUntilRef.current = Date.now() + 3200
    } else if (roll < 0.55) {
      glanceAway()
      idleUntilRef.current = Date.now() + 3000
    } else if (skinConfRef.current.dance && roll < 0.78) {
      doDance()
    } else {
      // 碎碎念:外层按当前数据冒一句话气泡
      window.dispatchEvent(new CustomEvent(MIKU_MURMUR_EVENT))
      idleUntilRef.current = Date.now() + 4500
    }
  }

  // 初始化:加载 Core → 创建透明 PIXI 舞台 → 加载模型并按容器尺寸适配
  useEffect(() => {
    let disposed = false
    let app: PIXI.Application | null = null
    let model: Live2DModelInstance | null = null

    // 调试句柄:白天可验证夜晚困困模式(window.__mikuDebug.setNight(true/false));
    // tick() 手动推一帧本舞台的 PIXI ticker——遮挡/后台页面 RAF 暂停时验证摆动等
    // 帧逻辑用(同页多舞台时以最后挂载者为准);stages 按变体保留全部舞台实例,
    // 可对指定舞台手动推帧,如 __mikuDebug.stages.fab.ticker.update()
    const win = window as unknown as Record<string, unknown>
    const debug = (win.__mikuDebug ??= {
      stages: {} as Record<string, PIXI.Application | null>,
      models: {} as Record<string, Live2DModelInstance | null>,
    }) as {
      setNight: (v: boolean) => void
      tick: () => void
      stages: Record<string, PIXI.Application | null>
      models: Record<string, Live2DModelInstance | null>
    }
    debug.setNight = (v: boolean) => {
      nightRef.current = v
    }
    debug.tick = () => app?.ticker.update()

    void (async () => {
      try {
        await ensureCubismCore()
        // 清理旧版机制残留在舞台盒节点上的影子变量(变量现由 onTick 每帧写在
        // 本组件宿主上,旧值继承下来会把影子钉在过期位置)
        hostRef.current?.parentElement?.style.removeProperty('--miku-slide-x')
        if (libFailed) throw new Error('Live2D 插件此前导入失败,不再重试')
        let Live2DModelCtor: typeof import('pixi-live2d-display/cubism4')['Live2DModel']
        try {
          ;({ Live2DModel: Live2DModelCtor } = await loadLive2DPlugin())
        } catch (err) {
          libFailed = true
          throw err
        }
        Live2DModelCtor.registerTicker(PIXI.Ticker)
        patchCrossContextShaderCache(Live2DModelCtor)
        if (disposed) return
        const settings = await buildModelSettings(skin)
        if (disposed) return
        app = new PIXI.Application({
          width,
          height,
          backgroundAlpha: 0,
          antialias: true,
          resolution: Math.min(window.devicePixelRatio || 1, 2),
          autoDensity: true,
          // 视觉居中回读像素需要:WebGL 默认每帧清空绘图缓冲,不保留则 readPixels 全空
          preserveDrawingBuffer: true,
        })
        if (disposed || !hostRef.current) return
        appRef.current = app
        // 挂载以来一直离屏(IO 已判定)的话,直接以暂停态起步
        if (!onScreenRef.current) app.ticker.stop()
        hostRef.current.appendChild(app.view as HTMLCanvasElement)
        model = await Live2DModelCtor.from(settings, { autoUpdate: true, autoInteract: false })
        if (disposed) {
          model.destroy({ children: true, texture: true, baseTexture: true })
          return
        }
        modelRef.current = model
        // 控制台调试句柄:可手动 model.expression('比心') 等(多舞台时为最后挂载者)
        ;(window as unknown as Record<string, unknown>).__miku = model
        const debugNow = (window as unknown as Record<string, unknown>).__mikuDebug as
          | { stages: Record<string, PIXI.Application | null>; models: Record<string, Live2DModelInstance | null> }
          | undefined
        if (debugNow) {
          debugNow.stages[variant] = app
          debugNow.models[variant] = model
        }
        // 整身放入容器:底部居中,留一点余量防止触边裁切
        model.anchor.set(0.5, 1)
        const s = Math.min(width / model.width, height / model.height) * 0.96
        model.scale.set(s)
        baseScaleRef.current = s
        model.position.set(width / 2, height)
        // 关闭作者水印:模型出厂 Param137=0(水印默认打开),置 1 即作者预留的关闭档
        // (水印.exp3.json 同款设置),已实测该参数无其他作用且跨帧保持
        ;(model.internalModel.coreModel as ParamWriter).setParameterValueById('Param137', 1)
        app.stage.addChild(model)
        // 揭幕:把「模型可见」从加载完成时刻拆出来。fab 变体就绪即揭幕;page
        // 大舞台先在透明画布后面(见 index.css 的 .miku-stage:not(.ready) 规则)
        // 静默测好居中修正再揭幕,她以修正后的位置随登场动画一次亮相,不再有
        // 「加载完向修正方向跳一下」。测量链路每条退路都会揭幕,另有硬保底,
        // 绝不会永远隐身
        let revealed = false
        const revealStage = () => {
          if (disposed || revealed) return
          revealed = true
          setReady(true)
          onReady?.()
        }
        // 视觉居中:对 page 大舞台,按实测偏移把可见形象对到画布中线;悬浮球
        // 构图已调好不做此修正。回读有撞上「渲染中途半帧/陈旧帧」的风险(轮廓
        // 中心被算歪),因此三帧采样要求两两一致才取中位数。修正量钳制按 15%
        // 舞台高:合法修正来自模型网格不对称,量级随模型缩放 ∝ 舞台高(实测
        // ~11%h);垃圾帧量级随画布宽走(半帧 ±35%w)。旧钳制按 20% 画布宽,
        // 画布铺满容器(1025~1200px)后放行空间是合法值的 3 倍,实测 +173px 的
        // 垃圾修正借此锁进 normalOffset,人停在中线右 24% 处——按高钳制后,
        // 合法值留 ~1.35 倍余量,半帧垃圾全部拒收
        if (variant === 'page') {
          // 三帧一致性采样:两两差 ≤8px 视为稳定,取中位数;不一致重测一轮。
          // 整轮失败(面板被节流 RAF 全停/连续撞上半帧等)由外层退避重试——
          // 面板回到屏幕后 RAF 恢复,下一轮即可完成,居中不会因时序被永久放弃。
          // done 承担揭幕职责,每条退出路径都必须调用
          const applyCentering = (attempt: number, done: () => void) => {
            requestAnimationFrame(() => {
              if (disposed || !model) { done(); return }
              // 用户已拖动:位置由用户决定,自动居中让位(同周期自检)
              if (slideXRef.current !== 0) { done(); return }
              const samples: number[] = []
              let reads = 0
              const next = () => {
                requestAnimationFrame(() => {
                  if (disposed || !model) { done(); return }
                  // 采样预算:扫描持续失败(读到全零帧等)时作废本轮——采样循环
                  // 吊死会把 done(揭幕)一起吊死,模型永远隐身
                  if (++reads > 24) { done(); return }
                  const sample = measureCenterDx()
                  if (sample !== null) samples.push(sample)
                  if (samples.length < 3) {
                    window.setTimeout(next, 160)
                    return
                  }
                  const sorted = [...samples].sort((a, b) => a - b)
                  if (sorted[2] - sorted[0] > 8 && attempt < 2) {
                    applyCentering(attempt + 1, done) // 三帧不一致:多半撞上动作/半帧,重测一轮
                    return
                  }
                  // 用户已拖动过(slideX ≠ 0)时,测得的偏差包含用户位移本身,只修
                  // 自然不对称——否则拖动位置会被当成偏移写进 normalOffset,整个人
                  // 被拉回画布中线(实测 slideX=163 时被锁入 -218 偏移)
                  const dx = sorted[1] + slideXRef.current
                  // 姿势瞬态(表情/动作)期间不写修正:剪影不代表居中站姿,量出来
                  // 的偏差会被锁进 normalOffset(进页面立刻投喂就可能触发)
                  if (Math.abs(dx) < 0.5 || Math.abs(dx) > height * 0.15) { done(); return }
                  if (expressionUntilRef.current > performance.now()) { done(); return }
                  if (normalOffsetRef.current !== 0) { done(); return } // 后续轮次兜底,首轮成功即不再重复修正
                  normalOffsetRef.current = dx
                  model.position.x += dx
                  basePosRef.current.x += dx
                  basePosTargetRef.current.x += dx
                  done()
                })
              }
              next()
            })
          }
          // 首发 800ms(等头发物理稳定);首轮结束即揭幕(成不成都亮),没写成
          // 再退避重测,最多三轮。重试前确认仍是「未修正且用户未拖动」状态,
          // 不抢别的写者已定好的位置
          const startCentering = (attempt: number) => {
            window.setTimeout(() => {
              if (disposed || modelRef.current !== model) { revealStage(); return }
              applyCentering(attempt, () => {
                revealStage()
                if (normalOffsetRef.current === 0 && attempt < 2) {
                  window.setTimeout(() => {
                    if (!disposed && modelRef.current === model && slideXRef.current === 0) {
                      startCentering(attempt + 1)
                    }
                  }, 2000)
                }
              })
            }, attempt === 0 ? 800 : 2000)
          }
          startCentering(0)
          window.setTimeout(revealStage, 8000) // 测量链路全灭时的硬保底
          // 周期自检:一次性修正若在采样窗口撞上瞬态(动作摆动/半帧),垃圾值
          // 会被 normalOffsetRef 锁死整个会话(实测出现过残差 +94px、模型右缘
          // 裁切,刷新才恢复)。这里每 4s 复测自愈:三帧两两一致(≤8px,滤掉动作
          // 瞬态)且残差超过呼吸/发丝慢摆幅度(实测峰值 ±10px)才补;补偿叠加进
          // 「当前形态」的偏移缓存,经 basePosTarget 平滑滑入。拖拽/舞蹈等主动
          // 摆动中不测,避免把摆动当成偏移
          let verifying = false
          centeringTimerRef.current = window.setInterval(() => {
            if (verifying || disposed || document.hidden || !stageVisible()) return
            // 保留动作(舞蹈或 pinned 表情)是持久的不对称姿势,自检的数学以居中
            // 站姿为前提;临时表情窗口(掏葱/比心等)同理,姿势期间不介入
            if (!readyRef.current || draggingRef.current || pinnedRef.current !== null) return
            if (expressionUntilRef.current > performance.now()) return
            // 用户拖动过:她站的位置由用户决定,自检的数学以「居中姿态」为前提,
            // 不再介入(否则会以各种基准把她拉来推去)
            if (slideXRef.current !== 0) return
            if (qqTargetRef.current === 1 && qqOffsetRef.current == null) return
            verifying = true
            const samples: number[] = []
            let reads = 0
            const tick = () => {
              if (disposed) {
                verifying = false
                return
              }
              // 采样预算:扫描持续失败时放弃本轮。verifying 不能卡死——卡死后
              // 自检永久失能,已锁入的垃圾修正就再也没人救了
              if (++reads > 12) {
                verifying = false
                return
              }
              const mm = modelRef.current
              // 位置被外部改动(偏离 basePos 影子,正常管线 position 每帧由 basePos
              // 驱动)时先归位再测:残差可能来自「位置漂移」而非「目标错误」,
              // 不归位会把两种误差叠在一起修正,造成来回过冲
              if (mm && Math.abs(mm.position.x - basePosRef.current.x) > 1) {
                mm.position.x = basePosRef.current.x
              }
              const dx = measureCenterDx()
              if (dx !== null) samples.push(dx)
              if (samples.length < 3) {
                window.setTimeout(tick, 350)
                return
              }
              verifying = false
              const sorted = [...samples].sort((a, b) => a - b)
              if (sorted[2] - sorted[0] > 8) return
              const residual = sorted[1]
              if (Math.abs(residual) < 16) return
              // 单轮步长钳到 15% 舞台高(与首次同一把尺):>16 的残差只应来自
              // 污染态,大残差分多轮收敛(±240 约四轮);单轮垃圾读数的最大伤害
              // 也被压进同一钳制,不再可能一轮把人推出去 1/3 画布
              const fix = Math.max(-height * 0.15, Math.min(height * 0.15, residual))
              // 修正后的目标不允许偏离画布中线超过 35%
              const targetX = basePosTargetRef.current.x + fix
              if (Math.abs(targetX - width / 2) > width * 0.35) return
              if (qqTargetRef.current === 1) qqOffsetRef.current = (qqOffsetRef.current ?? 0) + fix
              else normalOffsetRef.current += fix
              basePosTargetRef.current = { ...basePosTargetRef.current, x: targetX }
            }
            tick()
          }, 4000)
        }
        // 说话口型与夜晚困困眼皮必须在眨眼/表情/动作各自写完参数之后再处理,
        // 所以挂到 internalModel.update 尾部(写在外层 ticker 会与眨眼竞态来回跳)。
        // 参数不存在时 setParameterValueById 是无害的空写,对应效果自动退化
        const m = model
        // 眼皮开度覆盖(困困封顶 / 表情里的眯眼):**必须在核心算网格之前写**。
        // 库的 CubismEyeBlink.updateParameters 每帧都无条件绝对写一遍眼皮参数
        // (间隔态写 1,即睁开),而本帧网格是在 internalModel.update 尾部
        // coreModel.update() 那一刻定格的——写在 update 之后只改到下一帧的基础值,
        // 当帧网格仍用眨眼写的 1,效果等于没有(困困模式与「哭」的眯眼都栽在这里)。
        // 这里挂在 coreModel.update 之前:晚于眨眼/跟随/物理/pose,早于网格
        const core = m.internalModel.coreModel as ParamWriter & ParamReader & { update: () => void }
        const origCoreUpdate = core.update.bind(core)
        core.update = () => {
          for (const name of emoteOnRef.current) {
            for (const p of skinConfRef.current.emotes[name] ?? []) {
              if (p.mode === 'min') applyEmoteParam(core, p, true)
            }
          }
          if (nightRef.current) {
            core.setParameterValueById(
              'ParamEyeLOpen',
              Math.min(core.getParameterValueById('ParamEyeLOpen'), NIGHT_EYE_MAX),
            )
            core.setParameterValueById(
              'ParamEyeROpen',
              Math.min(core.getParameterValueById('ParamEyeROpen'), NIGHT_EYE_MAX),
            )
            nightWasRef.current = true
          } else if (nightWasRef.current) {
            nightWasRef.current = false
            core.setParameterValueById('ParamEyeLOpen', 1)
            core.setParameterValueById('ParamEyeROpen', 1)
          }
          origCoreUpdate()
        }
        const internal = m.internalModel as unknown as { update: (...args: unknown[]) => void }
        const origUpdate = internal.update.bind(internal)
        internal.update = (...args: unknown[]) => {          origUpdate(...args)
          const t = performance.now()
          // 说话口型:ParamMouthOpenY 快速开合,像在念出回复;
          // 结束帧补写 0 闭嘴——眨眼/表情都不写嘴部参数,不补会停在最后一次的开合度
          if (talkUntilRef.current > t) {
            core.setParameterValueById('ParamMouthOpenY', 0.2 + Math.abs(Math.sin(t / 110)) * 0.65)
            talkingRef.current = true
          } else if (talkingRef.current) {
            talkingRef.current = false
            core.setParameterValueById('ParamMouthOpenY', 0)
          }
          // 可叠加表情层:每帧写激活表情的参数档(关闭不写,由关闭瞬间的补 off 归位)。
          // 放在点头之前:点头是绝对写 ParamAngleY 的短动画,该由它压过「哭」的低头;
          // 眼皮类(mode='min')不在这里写,见上面的 coreModel.update 包装
          for (const name of emoteOnRef.current) {
            for (const p of skinConfRef.current.emotes[name] ?? []) {
              if (p.mode !== 'min') applyEmoteParam(core, p, true)
            }
          }
          // 点头:ParamAngleY 正弦两摆后自然归零(振幅随剩余时间衰减)。
          // focus 的眼神跟随每帧写头部角度,这里必须写在 update 之后才压得住
          if (nodUntilRef.current > t) {
            nodWasRef.current = true
            const k = (nodUntilRef.current - t) / NOD_MS
            core.setParameterValueById('ParamAngleY', -Math.sin(k * Math.PI * 4) * 13 * k)
          } else if (nodWasRef.current) {
            nodWasRef.current = false
            core.setParameterValueById('ParamAngleY', 0)
          }
          // 眯眼害羞:EyeL/R_Squint 是独立参数,与眨眼(眼皮开合)互不覆盖
          if (squintUntilRef.current > t) {
            squintWasRef.current = true
            core.setParameterValueById('EyeL_Squint', 1)
            core.setParameterValueById('EyeR_Squint', 1)
          } else if (squintWasRef.current) {
            squintWasRef.current = false
            core.setParameterValueById('EyeL_Squint', 0)
            core.setParameterValueById('EyeR_Squint', 0)
          }
          // 可叠加表情层:每帧写激活表情的参数档(只在尾部写,压过表情管理器/眨眼/
          // 眼神跟随的同参写入;关闭不写,由关闭瞬间的补 off 归位)。可用集按皮肤
          for (const name of emoteOnRef.current) {
            for (const p of skinConfRef.current.emotes[name] ?? []) applyEmoteParam(core, p, true)
          }
          // QQ 形态参数档:每帧渲染都无条件写。这个钩子挂在 internalModel.update
          // 尾部,而后者只在「真正渲染」时被 Live2DModel._render 调用(共享 ticker
          // 的 autoUpdate 只累积 deltaTime),所以写入天然与渲染同频:舞台隐藏时
          // 不写也不渲染,无副作用;恢复渲染后 tween 从当前档位继续走完,几帧内
          // 即是完整目标形态。写在 origUpdate 之后是硬要求——本帧 loadParameters
          // 会把参数恢复到快照,写在它前面会被同帧抹掉
          const lv = qqLevelRef.current
          const target = qqTargetRef.current
          if (lv !== target) {
            qqLevelRef.current = lv + Math.sign(target - lv) * Math.min(0.09, Math.abs(target - lv))
          }
          core.setParameterValueById('Param131', qqLevelRef.current)
          core.setParameterValueById('Param136', qqLevelRef.current)
        }
        // 哭的泪珠增强:挂在 draw 之前 —— 此时本帧网格已由核心算好、尚未提交 GPU,
        // 直接改 WASM 堆里的顶点,屏幕上的泪珠就变大并沿脸颊下滑(见 TEAR_* 注释)。
        // 不写任何参数、不碰模型文件;核心每帧重算网格,所以停哭后自动复原
        const rawModel = (m.internalModel.coreModel as unknown as {
          getModel: () => { drawables: { ids: string[]; vertexPositions: Float32Array[]; dynamicFlags: Uint8Array } }
        }).getModel()
        const tearGroups = TEAR_DRAWABLE_NAMES.map((names) =>
          names.map((n) => rawModel.drawables.ids.indexOf(n)).filter((i) => i >= 0),
        ).filter((g) => g.length > 0)
        // 渲染器可能按「顶点是否变化」决定要不要重传缓冲;这里把那一位置起来,
        // 保证改过的顶点一定上传(位掩码从 core 的 Utils 自行推导,不写死常量)
        const tearDirtyMask = (() => {
          const utils = (window as unknown as { Live2DCubismCore?: { Utils?: Record<string, (v: number) => boolean> } })
            .Live2DCubismCore?.Utils
          for (let b = 0; b < 8; b++) if (utils?.hasVertexPositionsDidChangeBit?.(1 << b)) return 1 << b
          return 0
        })()
        const internalDraw = m.internalModel as unknown as { draw: (gl: unknown) => void }
        const origDraw = internalDraw.draw.bind(internalDraw)
        internalDraw.draw = (gl: unknown) => {
          if (tearGroups.length && emoteOnRef.current.has('哭')) {
            const t = performance.now()
            for (let g = 0; g < tearGroups.length; g++) {
              const phase = (t + (g * TEAR_DRIP_PERIOD_MS) / 2) % TEAR_DRIP_PERIOD_MS
              const rest = TEAR_DRIP_PERIOD_MS - TEAR_DRIP_SLIDE_MS
              const p = phase <= rest ? 0 : (phase - rest) / TEAR_DRIP_SLIDE_MS
              const drop = p * p * (3 - 2 * p) * TEAR_DRIP_DROP
              for (const i of tearGroups[g]) {
                const v = rawModel.drawables.vertexPositions[i]
                if (!v || v.length < 6) continue
                // 以本帧网格的质心为中心放大,再整体下移 droppx
                let cx = 0
                let cy = 0
                for (let k = 0; k < v.length; k += 2) {
                  cx += v[k]
                  cy += v[k + 1]
                }
                cx /= v.length / 2
                cy /= v.length / 2
                for (let k = 0; k < v.length; k += 2) {
                  v[k] = cx + (v[k] - cx) * TEAR_SCALE
                  v[k + 1] = cy + (v[k + 1] - cy) * TEAR_SCALE - drop
                }
                if (tearDirtyMask) rawModel.drawables.dynamicFlags[i] |= tearDirtyMask
              }
            }
          }
          origDraw(gl)
        }
        // 每帧特效:拖动/挠痒痒/思考的摆动 + 弹跳弹簧(摆动互斥,弹跳独立)
        const onTick = () => {
          const mm = modelRef.current
          if (!mm || !readyRef.current) return
          const now = performance.now()
          if (draggingRef.current) {
            // 被拎着:身体按 ~1.1Hz 轻摆,头发物理自然跟随
            ;(mm.internalModel.coreModel as ParamWriter).setParameterValueById(
              'ParamBodyAngleZ',
              Math.sin(now / 180) * 7,
            )
            swayDirtyRef.current = true
          } else if (wiggleUntilRef.current > now) {
            // 挠痒痒:更高频小幅扭动
            ;(mm.internalModel.coreModel as ParamWriter).setParameterValueById(
              'ParamBodyAngleZ',
              Math.sin(now / 85) * 9,
            )
            swayDirtyRef.current = true
          } else if (thinkingRef.current) {
            // 等 AI 回复:慢速轻晃,像在思索
            ;(mm.internalModel.coreModel as ParamWriter).setParameterValueById(
              'ParamBodyAngleZ',
              Math.sin(now / 520) * 4,
            )
            swayDirtyRef.current = true
          } else if (swayDirtyRef.current) {
            swayDirtyRef.current = false
            ;(mm.internalModel.coreModel as ParamWriter).setParameterValueById('ParamBodyAngleZ', 0)
          }
          const start = bounceAtRef.current
          const groundY = basePosRef.current.y
          if (start !== null) {
            const t = (now - start) / 1000
            const D = 0.5
            if (t >= D) {
              bounceAtRef.current = null
              mm.scale.set(baseScaleRef.current)
              mm.position.y = groundY
            } else {
              // 阻尼弹簧挤压回弹 + 一次小跳,脚底锚定不穿帮
              const sy = 1 - 0.14 * Math.exp(-4.2 * t) * Math.sin(13 * t)
              const hop = 13 * Math.sin((Math.PI * t) / D)
              mm.scale.set(baseScaleRef.current * (1 - (sy - 1) * 0.9), baseScaleRef.current * sy)
              mm.position.y = groundY - hop
            }
          }
          // QQ 形态的参数档写入在 internal.update 尾部钩子(每次渲染各写一次,
          // 见上):支点平移在这里(app.ticker)做,tween 与参数写在那边做,
          // 两者都只在渲染时推进,恢复渲染后同步收敛
          const bp = basePosRef.current
          const bpTarget = basePosTargetRef.current
          if (bp.x !== bpTarget.x || bp.y !== bpTarget.y) {
            const nx = bp.x + (bpTarget.x - bp.x) * 0.18
            const ny = bp.y + (bpTarget.y - bp.y) * 0.18
            if (Math.abs(nx - bpTarget.x) < 0.5 && Math.abs(ny - bpTarget.y) < 0.5) {
              basePosRef.current = { ...bpTarget }
              mm.position.set(bpTarget.x, bpTarget.y)
            } else {
              basePosRef.current = { x: nx, y: ny }
              mm.position.set(nx, ny)
            }
          }
          // 影子跟随:每帧按模型「实际位置」同步 CSS 变量(单一写者)——拖动、
          // 形态切换、自动校准,任何来源的移动都自动覆盖,影子不可能脱节。
          // 普通形态扣除居中修正(QQ 形态无此项),变化超 0.5px 才写样式
          const relX =
            mm.position.x -
            (qqTargetRef.current === 1 ? 0 : normalOffsetRef.current) -
            width / 2
          if (shadowRelRef.current === null || Math.abs(relX - shadowRelRef.current) > 0.5) {
            shadowRelRef.current = relX
            hostRef.current?.style.setProperty('--miku-slide-x', `${Math.round(relX)}px`)
          }
        }
        app.ticker.add(onTick)
        readyRef.current = true
        // 就绪补应用保留动作:点击若落在载入窗口期(HMR 重挂/换皮肤/进页重载后的
        // 1-2s 召唤提示),事件到达时 readyRef 尚为 false,表情/舞蹈会被静默丢弃
        // 且窗口事件不会重放。保留动作是用户显式选择(按钮/菜单已点亮),就绪即补上
        // ——与下方 qqOn 就绪对齐同一思路
        const pinnedNow = pinnedRef.current
        if (pinnedNow) {
          if (skinConfRef.current.dance?.pin === pinnedNow) kickDanceLoop()
          else Promise.resolve(model.expression(pinnedNow)).catch(() => undefined)
        }
        // 加载期间外部 QQ 状态可能已变化(如养成页先变形、本实例模型后就绪):
        // 就绪即对齐,避免「菜单勾着、立绘却是普通形态」
        if (qqOnRef.current !== undefined && (qqOnRef.current ? 1 : 0) !== qqTargetRef.current) {
          applyQQRef.current?.(qqOnRef.current, false)
        }
        // 揭幕:fab 就绪即亮相;page 由居中测量链路揭幕(见上方 page 块)——
        // 测量期间画布保持透明,她带着修正后的位置一次登场,外层的召唤提示
        // (onReady 驱动)也会多留到揭幕为止
        if (variant !== 'page') {
          setReady(true)
          onReady?.()
        }
      } catch (err) {
        console.warn('[miku] Live2D 初始化失败,回退为图标', err)
        if (!disposed) onFailed?.()
      }
    })()

    return () => {
      disposed = true
      readyRef.current = false
      modelRef.current = null
      appRef.current = null
      if (centeringTimerRef.current !== null) {
        window.clearInterval(centeringTimerRef.current)
        centeringTimerRef.current = null
      }
      delete (window as unknown as Record<string, unknown>).__miku
      // 调试句柄只摘本舞台条目:同页另一舞台的 stages/models 还在用;全空才整个删掉
      const winCleanup = window as unknown as Record<string, unknown>
      const debugCleanup = winCleanup.__mikuDebug as
        | { stages?: Record<string, unknown>; models?: Record<string, unknown> }
        | undefined
      if (debugCleanup?.stages && debugCleanup.models) {
        delete debugCleanup.stages[variant]
        delete debugCleanup.models[variant]
        if (Object.keys(debugCleanup.stages).length === 0) delete winCleanup.__mikuDebug
      } else {
        delete winCleanup.__mikuDebug
      }
      window.clearTimeout(expressionTimerRef.current)
      window.clearTimeout(danceLoopTimerRef.current)
      model?.destroy({ children: true, texture: true, baseTexture: true })
      // destroy(false) 不摘除 view:不把画布从 DOM 移走的话,StrictMode 双挂载与
      // HMR 重挂载都会在宿主里留下一个 context 已丢失的死画布,既漏内存又会让
      // querySelector 拿错节点
      const view = app?.view as HTMLCanvasElement | undefined
      app?.destroy(false)
      view?.remove()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 离屏暂停:display:none(切走养成页/隐藏悬浮球)时停掉渲染 ticker,回屏再恢复。
  // 恢复主要靠下面的 visible prop(IO 回调偶发不派发,不能独自承担恢复职责);
  // 这里兜「挂载着但被滚动出视口」的省电暂停。停画期间共享 ticker 只是累积
  // deltaTime 不消费,恢复渲染首帧的巨额 dt 由 _render 补丁钳制(见文件头部)
  useEffect(() => {
    const el = hostRef.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver(
      (entries) => {
        const visible = entries.some((e) => e.isIntersecting)
        onScreenRef.current = visible
        if (!appRef.current) return
        if (visible) appRef.current.ticker.start()
        else appRef.current.ticker.stop()
      },
      { threshold: 0.01 },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [])

  // 渲染主开关:父组件按切页状态确定性启停渲染循环(见 props.visible 注释)。
  // 挂载早期 appRef 还没就绪:先把 onScreenRef 记下,初始化代码会按它决定
  // 「以暂停态起步」;之后再翻转到可见也无需补 start,初始化本身就会跑起来
  useEffect(() => {
    onScreenRef.current = visible
    const app = appRef.current
    if (!app) return
    if (visible) {
      if (!app.ticker.started) app.ticker.start()
    } else {
      app.ticker.stop()
    }
  }, [visible])

  // 全局 QQ 状态 → 本舞台跟随:qqOn 变化时对齐(隐藏中的实例也在内)。本舞台刚经
  // 事件 morph 并回写过状态时,这里自然命中「已一致」零操作,不会来回抖
  useEffect(() => {
    if (qqOn === undefined || !readyRef.current) return
    if ((qqTargetRef.current === 1) !== qqOn) applyQQRef.current(qqOn, false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qqOn])

  // 保留动作 → 本舞台跟随(pinnedAction 单真源在 App):变化时对齐;重挂(换皮肤/
  // 配置自愈/网格自愈)后新实例据此在新模型上恢复,否则按钮亮着而模型没动作。
  // 未就绪时也先把目标写进 pinnedRef(init 就绪补应用逻辑据此补上,见 init effect);
  // 本舞台自身经事件 morph 后回写过状态时,这里自然命中「已一致」零操作
  useEffect(() => {
    if (pinnedAction === undefined) return
    if ((pinnedRef.current ?? null) === pinnedAction) return
    if (pinnedAction === null) unpinAction()
    else pinAction(pinnedAction)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pinnedAction])

  // 夜晚困困模式开关:按本地小时每分钟轮询(21:00–06:00),调试可用 __mikuDebug.setNight 覆盖
  useEffect(() => {
    nightRef.current = isNightHour()
    const timer = window.setInterval(() => {
      nightRef.current = isNightHour()
    }, 60_000)
    return () => window.clearInterval(timer)
  }, [])

  // 眼睛/头部跟随鼠标:focus 接收舞台坐标系,鼠标位置减去舞台左上角即可(可在「显示」菜单关闭)
  useEffect(() => {
    if (!eyeFollow) return
    const onMove = (e: PointerEvent) => {
      if (!stageVisible()) return
      const model = modelRef.current
      const host = hostRef.current
      if (!model || !host || !readyRef.current) return
      const r = host.getBoundingClientRect()
      model.focus(e.clientX - r.left, e.clientY - r.top)
    }
    window.addEventListener('pointermove', onMove)
    return () => window.removeEventListener('pointermove', onMove)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eyeFollow])

  // 互动事件:分区点击反馈 / 拖动摆动开关 / AI 回复表情 / 庆祝 / 思考与说话 / 右键菜单表演。
  // 每个处理器先做可见性检查:同页挂了两个舞台实例(悬浮球 + 养成页)时只有可见的那个响应
  useEffect(() => {
    const onTap = (e: Event) => {
      if (!stageVisible()) return
      const clientY = (e as CustomEvent).detail?.clientY as number | undefined
      const now = performance.now()
      // 连击彩蛋:短时间内连点,第 5 下比心;连击过程广播给外层(养成页连击浮标)
      comboCountRef.current =
        now - comboLastAtRef.current <= COMBO_WINDOW_MS ? comboCountRef.current + 1 : 1
      comboLastAtRef.current = now
      if (comboCountRef.current >= 2) {
        window.dispatchEvent(
          new CustomEvent(MIKU_COMBO_EVENT, {
            detail: { count: comboCountRef.current, done: comboCountRef.current >= COMBO_N },
          }),
        )
      }
      if (comboCountRef.current >= COMBO_N) {
        comboCountRef.current = 0
        showExpression(skinExpr('比心'), 3000)
        bounceAtRef.current = now
        return
      }
      // QQ 形态太小分不出部位(或事件没带坐标):随机轻反应
      if (qqTargetRef.current === 1 || typeof clientY !== 'number') {
        showExpression(pickLight())
        bounceAtRef.current = now
        return
      }
      const r = hostRef.current?.getBoundingClientRect()
      const rel = r && r.height > 0 ? (clientY - r.top) / r.height : 0.5
      if (rel < ZONE_FACE) {
        // 摸摸头:害羞
        showExpression('脸红', 2600)
      } else if (rel < ZONE_BODY) {
        // 戳戳脸:惊讶
        showExpression('圈圈', 2400)
      } else {
        // 挠痒痒:扭一扭
        wiggleUntilRef.current = now + WIGGLE_MS
        showExpression(Math.random() < 0.5 ? '脸红' : '圈圈', 2400)
      }
      bounceAtRef.current = now
    }
    const onDragStart = () => {
      if (!stageVisible()) return
      draggingRef.current = true
    }
    const onDragEnd = () => {
      if (!stageVisible()) return
      draggingRef.current = false
      // 落地小弹跳
      if (readyRef.current) bounceAtRef.current = performance.now()
    }
    // 舞台内左右拖动(养成页):dx 增量平移支点目标,钳制在画布两侧留边内;
    // 累计位移记入 slideXRef(居中自检/QQ 切换以此为基准),并同步 CSS 变量
    // 让面板的脚下影子跟随
    const onSlide = (e: Event) => {
      if (!stageVisible() || !readyRef.current) return
      const dx = (e as CustomEvent).detail?.dx as number | undefined
      if (typeof dx !== 'number' || dx === 0) return
      const app = appRef.current
      if (app && !app.ticker.started) app.ticker.start() // 兜底拉起渲染循环(幂等)
      const b = slideBounds(true)
      const next = Math.min(Math.max(basePosTargetRef.current.x + dx, b.min), b.max)
      slideXRef.current = Math.min(
        Math.max(slideXRef.current + (next - basePosTargetRef.current.x), -width * 0.7),
        width * 0.7,
      )
      basePosTargetRef.current = { ...basePosTargetRef.current, x: next }
    }
    const onExpress = () => {
      if (!stageVisible()) return
      showExpression(pickLight())
    }
    // 右键菜单「动作」:pin = 保留动作(一直保持);不带 pin 的是一次性表演;
    // clear = 取消保留回到默认;dance = 舞蹈(一次性)。
    // 口型独立于表情处理:某皮肤没有唱歌手势时(resolveExpression 为 null),
    // 外层只派 talkMs,口型照常开口
    const onPlay = (e: Event) => {
      if (!stageVisible()) return
      const detail = (e as CustomEvent).detail as
        | { expression?: string; dance?: boolean; talkMs?: number; pin?: boolean; clear?: boolean }
        | undefined
      if (detail?.dance) {
        doDance()
        return
      }
      if (detail?.clear) {
        unpinAction()
        return
      }
      if (detail?.talkMs) talkUntilRef.current = performance.now() + detail.talkMs
      if (detail?.expression) {
        if (detail.pin) pinAction(detail.expression)
        else showExpression(detail.expression, 3200)
      }
    }
    // 双击切换 QQ 人形态:持续参数档,进出都带弹跳;变身后不受表情复位影响。
    // 同时平滑平移模型支点(站回按钮底沿)并通知外层缩放按钮盒。
    // 双击切换 QQ 人形态:本舞台可见时由事件驱动并回写全局状态(onQQChange),
    // 隐藏中的另一个舞台经 qqOn 属性跟随(见 applyQQ 与同步 effect)
    const onQQ = () => {
      if (!stageVisible() || !readyRef.current) return
      // 兜底拉起渲染循环:start() 幂等。可见性判定已通过而渲染仍停着的情况
      // (历史上 IO 丢回调)曾让双击后画布冻结在旧帧、看起来毫无反应
      const app = appRef.current
      if (app && !app.ticker.started) app.ticker.start()
      applyQQRef.current(qqTargetRef.current === 0, true)
    }
    const onThinking = (e: Event) => {
      if (!stageVisible()) return
      thinkingRef.current = !!(e as CustomEvent).detail?.on
    }
    const onSpeak = (e: Event) => {
      if (!stageVisible()) return
      const ms = (e as CustomEvent).detail?.ms as number | undefined
      talkUntilRef.current = performance.now() + Math.min(Math.max(ms ?? 2200, 1200), 5000)
      if (readyRef.current) bounceAtRef.current = performance.now()
    }
    // 可叠加表情开关:激活写 on、关闭补 off(参数跨帧持久,不补会停在激活值)。
    // 可用集按皮肤(skinConfRef.emotes),越权名字直接忽略;写入复用组件级
    // writeEmoteParams(与 prop 对账那条路径同一份实现)
    const onEmote = (e: Event) => {
      if (!stageVisible()) return
      const detail = (e as CustomEvent).detail as { name?: string; clearA?: boolean } | undefined
      if (detail?.clearA) {
        for (const name of emoteOnRef.current) writeEmoteParams(name, false)
        emoteOnRef.current.clear()
        return
      }
      const name = detail?.name
      if (!name || !skinConfRef.current.emotes[name]) return
      if (emoteOnRef.current.has(name)) {
        emoteOnRef.current.delete(name)
        writeEmoteParams(name, false)
      } else {
        emoteOnRef.current.add(name)
        writeEmoteParams(name, true)
      }
    }
    const onCelebrate = () => {
      if (!stageVisible()) return
      const now = performance.now()
      if (now - celebrateAtRef.current < CELEBRATE_COOLDOWN_MS) return
      celebrateAtRef.current = now
      showExpression(Math.random() < 0.5 ? skinExpr('比心') : '圈圈', 3200)
      bounceAtRef.current = now
    }
    // 无冷却轻庆祝:小游戏连击反馈(celebrate 的 1.5s 冷却会吞掉密集反应)
    const onCheer = () => {
      if (!stageVisible() || !readyRef.current) return
      showExpression(pickLight(), 1600)
      bounceAtRef.current = performance.now()
    }
    const onNod = () => {
      if (!stageVisible() || !readyRef.current) return
      nodUntilRef.current = performance.now() + NOD_MS
    }
    const onSquint = (e: Event) => {
      if (!stageVisible() || !readyRef.current) return
      const ms = (e as CustomEvent).detail?.ms as number | undefined
      squintUntilRef.current = performance.now() + Math.min(Math.max(ms ?? 2600, 800), 5000)
      showExpression('脸红', 2600)
    }
    window.addEventListener(MIKU_TAP_EVENT, onTap)
    window.addEventListener(MIKU_DRAG_START_EVENT, onDragStart)
    window.addEventListener(MIKU_DRAG_END_EVENT, onDragEnd)
    window.addEventListener(MIKU_SLIDE_EVENT, onSlide)
    window.addEventListener(MIKU_EXPRESS_EVENT, onExpress)
    window.addEventListener(MIKU_QQ_EVENT, onQQ)
    window.addEventListener(MIKU_PLAY_EVENT, onPlay)
    window.addEventListener(MIKU_CELEBRATE_EVENT, onCelebrate)
    window.addEventListener(MIKU_THINKING_EVENT, onThinking)
    window.addEventListener(MIKU_SPEAK_EVENT, onSpeak)
    window.addEventListener(MIKU_CHEER_EVENT, onCheer)
    window.addEventListener(MIKU_NOD_EVENT, onNod)
    window.addEventListener(MIKU_SQUINT_EVENT, onSquint)
    window.addEventListener(MIKU_EMOTE_EVENT, onEmote)
    return () => {
      window.removeEventListener(MIKU_TAP_EVENT, onTap)
      window.removeEventListener(MIKU_DRAG_START_EVENT, onDragStart)
      window.removeEventListener(MIKU_DRAG_END_EVENT, onDragEnd)
      window.removeEventListener(MIKU_SLIDE_EVENT, onSlide)
      window.removeEventListener(MIKU_EXPRESS_EVENT, onExpress)
      window.removeEventListener(MIKU_QQ_EVENT, onQQ)
      window.removeEventListener(MIKU_PLAY_EVENT, onPlay)
      window.removeEventListener(MIKU_CELEBRATE_EVENT, onCelebrate)
      window.removeEventListener(MIKU_THINKING_EVENT, onThinking)
      window.removeEventListener(MIKU_SPEAK_EVENT, onSpeak)
      window.removeEventListener(MIKU_CHEER_EVENT, onCheer)
      window.removeEventListener(MIKU_NOD_EVENT, onNod)
      window.removeEventListener(MIKU_SQUINT_EVENT, onSquint)
      window.removeEventListener(MIKU_EMOTE_EVENT, onEmote)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 闲置彩蛋:长时间没动静自己找乐子(小表情 / 看别处 / 拿葱舞 / 碎碎念);
  // 有动静立即收敛;可在「显示」菜单关闭
  useEffect(() => {
    let lastActive = Date.now()
    let lastAct = 0
    const markActive = () => {
      lastActive = Date.now()
      // 用户回来了:彩蛋立刻收场(动作最多再闪 2.7s 内部曲线,表情回到保留动作)
      if (Date.now() < idleUntilRef.current) {
        idleUntilRef.current = 0
        window.clearTimeout(expressionTimerRef.current)
        restoreExpressionSafe()
        stopMotionSafe()
      }
    }
    const check = () => {
      if (!idleOnRef.current || document.hidden || !readyRef.current || draggingRef.current) return
      if (!stageVisible()) return
      const now = Date.now()
      if (now < idleUntilRef.current) return
      if (now - lastActive < IDLE_MS || now - lastAct < IDLE_COOLDOWN_MS) return
      lastAct = now
      doIdleAct()
    }
    window.addEventListener('pointermove', markActive)
    window.addEventListener('pointerdown', markActive)
    window.addEventListener('keydown', markActive)
    const timer = window.setInterval(check, 4000)
    return () => {
      window.removeEventListener('pointermove', markActive)
      window.removeEventListener('pointerdown', markActive)
      window.removeEventListener('keydown', markActive)
      window.clearInterval(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 开关同步 + 运行中关闭彩蛋:立即收场
  useEffect(() => {
    idleOnRef.current = idleEnabled
    if (!idleEnabled) {
      idleUntilRef.current = 0
      window.clearTimeout(expressionTimerRef.current)
      restoreExpressionSafe()
      stopMotionSafe()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idleEnabled])

  // 绝对定位挂在按钮底部居中,不参与布局;ready 前无画布,不可见也不拦事件
  return (
    <div
      ref={hostRef}
      className={`miku-stage${variant === 'page' ? ' page' : ''}${ready ? ' ready' : ''}`}
      style={{ width, height }}
      aria-hidden="true"
    >
      {/* 脚下影子(page 变体):随 --miku-slide-x 平移。住在宿主内——宿主重挂
          (网格自愈/HMR/切页)时影子与 slideXRef 一起重置,永不与模型位置脱节 */}
      {variant === 'page' && <div className="stage-shadow" aria-hidden="true" />}
    </div>
  )
}

const MikuStage = forwardRef(MikuStageInner)
export default MikuStage
