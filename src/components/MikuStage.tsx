import { useEffect, useRef } from 'react'
import * as PIXI from 'pixi.js'
import type { Live2DModel as Live2DModelInstance } from 'pixi-live2d-display/cubism4'

// ---------- AI 悬浮球的 Live2D 小组件:渲染 Miku 模型,替代原星星图标 ----------
// 模型文件在 public/live2d/miku/(含全部表情/动作文件);版权模型,仅本地使用,勿提交/分发。
// 交互约定:点击/拖动都由外层 .ai-fab 按钮统一处理,App 通过 window 事件通知这里做反馈:
//   miku:tap(detail.clientY 点击纵坐标,按位置分区反应) / miku:dragstart / miku:dragend /
//   miku:express(AI 回复轻表情) / miku:celebrate(完成待办/打卡庆祝) / miku:thinking(on) /
//   miku:speak(ms 口型时长) / miku:murmur(请求外层冒一句碎碎念) / miku:play / miku:qq。
// 这里只负责渲染与"活着"的部分:眨眼 + 呼吸内置,眼睛/头部跟随鼠标,点击分区反馈+弹跳,
// 拖动身体轻摆,等 AI 回复时慢速晃,说话口型,闲置自娱彩蛋,夜晚(21–06 点)困困模式。
// 初始化失败(缺 Core、无 WebGL、模型损坏)时回调 onFailed,由外层回退为星星图标。

const MODEL_URL = '/live2d/miku/miku.model3.json'
const CORE_URL = '/live2d/live2dcubismcore.min.js'

// AI 回复/闲置/随机反应共用的轻表情
const LIGHT_EXPRESSIONS = ['比心', '脸红', '圈圈']
const EXPRESSION_MS = 2800
// 保留动作里的舞蹈标记(pinnedRef 存这个值 = 循环拿葱舞)
const DANCE_PIN = '拿葱舞'

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

// 舞台尺寸:竖向容器,模型底部居中站立
const STAGE_W = 170
const STAGE_H = 230

// QQ 人形态(Param131/136)的 morph 实测:角色缩至约 37%,头顶钉在原画布顶部,
// 脚底升高约 140 舞台像素、视觉中心右偏约 26px。变身时把模型平移回去,
// 让 Q 版小人站回按钮底沿、居中于缩小后的盒子(按钮尺寸见 CSS .ai-fab.miku-qq)。
const QQ_PIVOT_SHIFT = { x: -26, y: 140 }
const BASE_POS_NORMAL = { x: STAGE_W / 2, y: STAGE_H }
const BASE_POS_QQ = { x: STAGE_W / 2 + QQ_PIVOT_SHIFT.x, y: STAGE_H + QQ_PIVOT_SHIFT.y }

// 互动事件名(与 App 解耦,通过 window CustomEvent 通信)
export const MIKU_EXPRESS_EVENT = 'miku:express'
export const MIKU_TAP_EVENT = 'miku:tap'
export const MIKU_DRAG_START_EVENT = 'miku:dragstart'
export const MIKU_DRAG_END_EVENT = 'miku:dragend'
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

declare global {
  interface Window {
    Live2DCubismCore?: unknown
  }
}

type ParamWriter = { setParameterValueById(id: string, value: number): void }
type ParamReader = { getParameterValueById(id: string): number }

/** 完成待办/习惯打卡后让 Miku 庆祝一下(未启用 Live2D 时无监听方,无副作用) */
export function celebrateMiku() {
  window.dispatchEvent(new CustomEvent(MIKU_CELEBRATE_EVENT))
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

// 拉取模型设置。model3.json 本身没有声明表情/动作,这里在内存里把模型自带的表情文件
// 与拿葱动作(Scene1,即 VTS 动作按键)注册进去(不改动磁盘上的任何模型文件);
// 水印表情刻意不注册,水印参数在模型加载后直接按作者预留档位关闭。
async function buildModelSettings(): Promise<Record<string, unknown>> {
  const res = await fetch(MODEL_URL)
  if (!res.ok) throw new Error(`模型设置加载失败: ${res.status}`)
  const json = (await res.json()) as Record<string, any>
  // settings 需要携带自身 url,用于解析相对路径的 moc/贴图/表情/动作引用
  json.url = MODEL_URL
  const names = ['比心', '脸红', '圈圈', '唱歌', '葱', 'QQ人', '前倾']
  json.FileReferences.Expressions = names.map((name) => ({ Name: name, File: `${name}.exp3.json` }))
  json.FileReferences.Motions = { Dance: [{ File: 'Scene1.motion3.json' }] }
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
}

export default function MikuStage({
  onReady,
  onFailed,
  onQQChange,
  eyeFollow = true,
  idleEnabled = true,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const modelRef = useRef<Live2DModelInstance | null>(null)
  const readyRef = useRef(false)
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
  const basePosRef = useRef({ ...BASE_POS_NORMAL })
  const basePosTargetRef = useRef({ ...BASE_POS_NORMAL })
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
  // 保留动作(右键菜单「动作」选的表情):本会话内一直保持;期间的点击反应/AI 回复
  // 表情/闲置彩蛋都是临时客串,结束后回到她。null = 无保留(临时表情结束即复原)。
  // 值为 DANCE_PIN 时 = 循环拿葱舞。刷新页面回默认待机,不做跨刷新记忆
  const pinnedRef = useRef<string | null>(null)
  // 循环拿葱舞的重启定时器(独立于表情复原定时器:临时表情不会打断舞蹈循环)
  const danceLoopTimerRef = useRef<number | undefined>(undefined)

  // 临时表情结束后的复原:有保留动作则回到她(舞蹈保留回葱表情),否则完全复位
  const restoreExpressionSafe = () => {
    try {
      const model = modelRef.current
      const pinned = pinnedRef.current
      if (model && pinned) {
        Promise.resolve(model.expression(pinned === DANCE_PIN ? '葱' : pinned)).catch(() => undefined)
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
    window.clearTimeout(expressionTimerRef.current)
    expressionTimerRef.current = window.setTimeout(restoreExpressionSafe, ms)
  }

  // 保留动作:立即应用且不设复原定时器(一直保持,直到换成别的或取消)。
  // 舞蹈是动作不是表情:交给循环重启器
  const pinAction = (name: string) => {
    pinnedRef.current = name
    window.clearTimeout(expressionTimerRef.current)
    if (name === DANCE_PIN) {
      kickDanceLoop()
      return
    }
    const model = modelRef.current
    if (model && readyRef.current) Promise.resolve(model.expression(name)).catch(() => undefined)
  }

  // 循环拿葱舞:跳完 DANCE_MS 后只要还保留着舞蹈就再起一轮
  // (定时器独立于表情复原定时器,临时表情客串不会打断循环)
  const kickDanceLoop = () => {
    window.clearTimeout(danceLoopTimerRef.current)
    doDance()
    danceLoopTimerRef.current = window.setTimeout(() => {
      if (pinnedRef.current === DANCE_PIN) kickDanceLoop()
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
    const x = r.left + STAGE_W / 2 + (Math.random() * 2 - 1) * 900
    const y = r.top + STAGE_H / 2 + (Math.random() * 2 - 1) * 700
    model.focus(x, y)
  }

  // 闲置彩蛋之一:掏出大葱挥一段舞(模型自带动作),失败降级为普通表情
  const doDance = () => {
    const model = modelRef.current
    if (!model || !readyRef.current) return
    const fallback = () => showExpression('圈圈', 3000)
    Promise.resolve(model.expression('葱')).catch(fallback)
    Promise.resolve(model.motion('Dance', 0))
      .then((ok) => {
        if (!ok) fallback()
      })
      .catch(fallback)
    idleUntilRef.current = Date.now() + DANCE_MS
    window.clearTimeout(expressionTimerRef.current)
    expressionTimerRef.current = window.setTimeout(restoreExpressionSafe, DANCE_MS)
  }

  const doIdleAct = () => {
    const roll = Math.random()
    if (roll < 0.3) {
      showExpression(LIGHT_EXPRESSIONS[Math.floor(Math.random() * LIGHT_EXPRESSIONS.length)], 3200)
      idleUntilRef.current = Date.now() + 3200
    } else if (roll < 0.55) {
      glanceAway()
      idleUntilRef.current = Date.now() + 3000
    } else if (roll < 0.78) {
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
    // tick() 手动推一帧 PIXI ticker——遮挡/后台页面 RAF 暂停时验证摆动等帧逻辑用
    ;(window as unknown as Record<string, unknown>).__mikuDebug = {
      setNight: (v: boolean) => {
        nightRef.current = v
      },
      tick: () => app?.ticker.update(),
    }

    void (async () => {
      try {
        await ensureCubismCore()
        if (libFailed) throw new Error('Live2D 插件此前导入失败,不再重试')
        let Live2DModelCtor: typeof import('pixi-live2d-display/cubism4')['Live2DModel']
        try {
          ;({ Live2DModel: Live2DModelCtor } = await loadLive2DPlugin())
        } catch (err) {
          libFailed = true
          throw err
        }
        Live2DModelCtor.registerTicker(PIXI.Ticker)
        if (disposed) return
        const settings = await buildModelSettings()
        if (disposed) return
        app = new PIXI.Application({
          width: STAGE_W,
          height: STAGE_H,
          backgroundAlpha: 0,
          antialias: true,
          resolution: Math.min(window.devicePixelRatio || 1, 2),
          autoDensity: true,
        })
        if (disposed || !hostRef.current) return
        hostRef.current.appendChild(app.view as HTMLCanvasElement)
        model = await Live2DModelCtor.from(settings, { autoUpdate: true, autoInteract: false })
        if (disposed) {
          model.destroy({ children: true, texture: true, baseTexture: true })
          return
        }
        modelRef.current = model
        // 控制台调试句柄:可手动 model.expression('比心') 等
        ;(window as unknown as Record<string, unknown>).__miku = model
        // 整身放入容器:底部居中,留一点余量防止触边裁切
        model.anchor.set(0.5, 1)
        const s = Math.min(STAGE_W / model.width, STAGE_H / model.height) * 0.96
        model.scale.set(s)
        baseScaleRef.current = s
        model.position.set(STAGE_W / 2, STAGE_H)
        // 关闭作者水印:模型出厂 Param137=0(水印默认打开),置 1 即作者预留的关闭档
        // (水印.exp3.json 同款设置),已实测该参数无其他作用且跨帧保持
        ;(model.internalModel.coreModel as ParamWriter).setParameterValueById('Param137', 1)
        app.stage.addChild(model)
        // 说话口型与夜晚困困眼皮必须在眨眼/表情/动作各自写完参数之后再处理,
        // 所以挂到 internalModel.update 尾部(写在外层 ticker 会与眨眼竞态来回跳)。
        // 参数不存在时 setParameterValueById 是无害的空写,对应效果自动退化
        const m = model
        const internal = m.internalModel as unknown as { update: (...args: unknown[]) => void }
        const origUpdate = internal.update.bind(internal)
        internal.update = (...args: unknown[]) => {
          origUpdate(...args)
          const core = m.internalModel.coreModel as ParamWriter & ParamReader
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
          // 夜晚困困:眼皮开度封顶(表情闭眼/眨眼闭合不受影响)。封顶写的是跨帧
          // 基础值(update 末尾 loadParameters 会回滚表情/眨眼的帧内写入),退出
          // 夜晚时基础值会停在封顶值,补一次写回全开
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
          // QQ 形态过渡:参数档与支点位置同步滑向目标(约 0.2s),写作者的 QQ人 参数档
          const lv = qqLevelRef.current
          const target = qqTargetRef.current
          if (lv !== target) {
            const next = lv + Math.sign(target - lv) * Math.min(0.09, Math.abs(target - lv))
            qqLevelRef.current = next
            const core = mm.internalModel.coreModel as ParamWriter
            core.setParameterValueById('Param131', next)
            core.setParameterValueById('Param136', next)
          }
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
        }
        app.ticker.add(onTick)
        readyRef.current = true
        onReady?.()
      } catch (err) {
        console.warn('[miku] Live2D 初始化失败,回退为图标', err)
        if (!disposed) onFailed?.()
      }
    })()

    return () => {
      disposed = true
      readyRef.current = false
      modelRef.current = null
      delete (window as unknown as Record<string, unknown>).__miku
      delete (window as unknown as Record<string, unknown>).__mikuDebug
      window.clearTimeout(expressionTimerRef.current)
      window.clearTimeout(danceLoopTimerRef.current)
      model?.destroy({ children: true, texture: true, baseTexture: true })
      app?.destroy(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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
      const model = modelRef.current
      const host = hostRef.current
      if (!model || !host || !readyRef.current) return
      const r = host.getBoundingClientRect()
      model.focus(e.clientX - r.left, e.clientY - r.top)
    }
    window.addEventListener('pointermove', onMove)
    return () => window.removeEventListener('pointermove', onMove)
  }, [eyeFollow])

  // 互动事件:分区点击反馈 / 拖动摆动开关 / AI 回复表情 / 庆祝 / 思考与说话 / 右键菜单表演
  useEffect(() => {
    const onTap = (e: Event) => {
      const clientY = (e as CustomEvent).detail?.clientY as number | undefined
      const now = performance.now()
      // 连击彩蛋:短时间内连点,第 5 下比心
      comboCountRef.current =
        now - comboLastAtRef.current <= COMBO_WINDOW_MS ? comboCountRef.current + 1 : 1
      comboLastAtRef.current = now
      if (comboCountRef.current >= COMBO_N) {
        comboCountRef.current = 0
        showExpression('比心', 3000)
        bounceAtRef.current = now
        return
      }
      // QQ 形态太小分不出部位(或事件没带坐标):随机轻反应
      if (qqTargetRef.current === 1 || typeof clientY !== 'number') {
        showExpression(LIGHT_EXPRESSIONS[Math.floor(Math.random() * LIGHT_EXPRESSIONS.length)])
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
      draggingRef.current = true
    }
    const onDragEnd = () => {
      draggingRef.current = false
      // 落地小弹跳
      if (readyRef.current) bounceAtRef.current = performance.now()
    }
    const onExpress = () => {
      showExpression(LIGHT_EXPRESSIONS[Math.floor(Math.random() * LIGHT_EXPRESSIONS.length)])
    }
    // 右键菜单「动作」:pin = 保留动作(一直保持);不带 pin 的是一次性表演;
    // clear = 取消保留回到默认;dance = 拿葱舞(一次性)
    const onPlay = (e: Event) => {
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
      if (detail?.expression) {
        if (detail.pin) pinAction(detail.expression)
        else showExpression(detail.expression, 3200)
        if (detail.talkMs) talkUntilRef.current = performance.now() + detail.talkMs
      }
    }
    // 双击切换 QQ 人形态:持续参数档,进出都带弹跳;变身后不受表情复位影响。
    // 同时平滑平移模型支点(站回按钮底沿)并通知外层缩放按钮盒。
    const onQQ = () => {
      if (!readyRef.current) return
      const entering = qqTargetRef.current === 0
      qqTargetRef.current = entering ? 1 : 0
      basePosTargetRef.current = entering ? { ...BASE_POS_QQ } : { ...BASE_POS_NORMAL }
      bounceAtRef.current = performance.now()
      onQQChange?.(entering)
    }
    const onThinking = (e: Event) => {
      thinkingRef.current = !!(e as CustomEvent).detail?.on
    }
    const onSpeak = (e: Event) => {
      const ms = (e as CustomEvent).detail?.ms as number | undefined
      talkUntilRef.current = performance.now() + Math.min(Math.max(ms ?? 2200, 1200), 5000)
      if (readyRef.current) bounceAtRef.current = performance.now()
    }
    const onCelebrate = () => {
      const now = performance.now()
      if (now - celebrateAtRef.current < CELEBRATE_COOLDOWN_MS) return
      celebrateAtRef.current = now
      showExpression(Math.random() < 0.5 ? '比心' : '圈圈', 3200)
      bounceAtRef.current = now
    }
    window.addEventListener(MIKU_TAP_EVENT, onTap)
    window.addEventListener(MIKU_DRAG_START_EVENT, onDragStart)
    window.addEventListener(MIKU_DRAG_END_EVENT, onDragEnd)
    window.addEventListener(MIKU_EXPRESS_EVENT, onExpress)
    window.addEventListener(MIKU_QQ_EVENT, onQQ)
    window.addEventListener(MIKU_PLAY_EVENT, onPlay)
    window.addEventListener(MIKU_CELEBRATE_EVENT, onCelebrate)
    window.addEventListener(MIKU_THINKING_EVENT, onThinking)
    window.addEventListener(MIKU_SPEAK_EVENT, onSpeak)
    return () => {
      window.removeEventListener(MIKU_TAP_EVENT, onTap)
      window.removeEventListener(MIKU_DRAG_START_EVENT, onDragStart)
      window.removeEventListener(MIKU_DRAG_END_EVENT, onDragEnd)
      window.removeEventListener(MIKU_EXPRESS_EVENT, onExpress)
      window.removeEventListener(MIKU_QQ_EVENT, onQQ)
      window.removeEventListener(MIKU_PLAY_EVENT, onPlay)
      window.removeEventListener(MIKU_CELEBRATE_EVENT, onCelebrate)
      window.removeEventListener(MIKU_THINKING_EVENT, onThinking)
      window.removeEventListener(MIKU_SPEAK_EVENT, onSpeak)
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
    <div ref={hostRef} className="miku-stage" style={{ width: STAGE_W, height: STAGE_H }} aria-hidden="true" />
  )
}
