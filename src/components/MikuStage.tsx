import { useEffect, useRef } from 'react'
import * as PIXI from 'pixi.js'
import type { Live2DModel as Live2DModelInstance } from 'pixi-live2d-display/cubism4'

// ---------- AI 悬浮球的 Live2D 小组件:渲染 Miku 模型,替代原星星图标 ----------
// 模型文件在 public/live2d/miku/(含全部表情/动作文件);版权模型,仅本地使用,勿提交/分发。
// 交互约定:点击/拖动都由外层 .ai-fab 按钮统一处理,App 通过 window 事件(miku:tap /
// miku:dragstart / miku:dragend / miku:express)通知这里做反馈;这里只负责渲染与"活着"的部分
// (眨眼 + 呼吸内置,眼睛/头部跟随鼠标,点击弹跳+表情+粒子,拖动身体轻摆,闲置自娱彩蛋)。
// 初始化失败(缺 Core、无 WebGL、模型损坏)时回调 onFailed,由外层回退为星星图标。

const MODEL_URL = '/live2d/miku/miku.model3.json'
const CORE_URL = '/live2d/live2dcubismcore.min.js'

// AI 回复:随机轻表情;点击她:表情 + 对应粒子 + 弹跳
const REPLY_EXPRESSIONS = ['比心', '脸红', '圈圈']
const TAP_REACTIONS: Array<[string, string]> = [
  ['比心', '♥'],
  ['脸红', '💗'],
  ['圈圈', '✨'],
]
const EXPRESSION_MS = 2800

// 闲置彩蛋:多久没动静开始自娱 / 彩蛋之间的最短间隔 / 拿葱舞时长(模型自带动作 2.67s/轮)
const IDLE_MS = 40_000
const IDLE_COOLDOWN_MS = 70_000
const DANCE_MS = 2667 * 2 + 300

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
/** 指定表演:detail 为 { expression?: 名称 } 或 { dance?: true }(右键菜单「动作」用) */
export const MIKU_PLAY_EVENT = 'miku:play'

declare global {
  interface Window {
    Live2DCubismCore?: unknown
  }
}

type ParamWriter = { setParameterValueById(id: string, value: number): void }

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

export default function MikuStage({ onReady, onFailed, onQQChange, eyeFollow = true, idleEnabled = true }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const fxRef = useRef<HTMLDivElement>(null)
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

  const resetExpressionSafe = () => {
    try {
      modelRef.current?.internalModel.motionManager.expressionManager?.resetExpression()
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

  // 表情粒子:从她胸口附近冒出向上飘散,CSS 动画结束自动移除;QQ 形态下胸口变矮,起点下移
  const spawnFx = (char: string, count = 3) => {
    const layer = fxRef.current
    if (!layer) return
    const low = qqTargetRef.current === 1
    for (let i = 0; i < count; i++) {
      const el = document.createElement('span')
      el.className = 'miku-fx-bit'
      el.textContent = char
      el.style.left = `${34 + Math.random() * 32}%`
      el.style.bottom = `${(low ? 8 : 30) + Math.random() * 22}%`
      el.style.setProperty('--dx', `${(Math.random() * 44 - 22).toFixed(0)}px`)
      el.style.setProperty('--dur', `${(1.1 + Math.random() * 0.7).toFixed(2)}s`)
      el.addEventListener('animationend', () => el.remove())
      layer.appendChild(el)
    }
  }

  // 设表情并在几秒后复原;可选带粒子。所有表情类互动共用,避免复位定时器互相打架
  const showExpression = (name: string, particle?: string, ms = EXPRESSION_MS) => {
    const model = modelRef.current
    if (!model || !readyRef.current) return
    Promise.resolve(model.expression(name)).catch(() => undefined)
    if (particle) spawnFx(particle)
    window.clearTimeout(expressionTimerRef.current)
    expressionTimerRef.current = window.setTimeout(resetExpressionSafe, ms)
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
    const fallback = () => showExpression('圈圈', undefined, 3000)
    Promise.resolve(model.expression('葱')).catch(fallback)
    Promise.resolve(model.motion('Dance', 0))
      .then((ok) => {
        if (!ok) fallback()
      })
      .catch(fallback)
    spawnFx('♪', 4)
    idleUntilRef.current = Date.now() + DANCE_MS
    window.clearTimeout(expressionTimerRef.current)
    expressionTimerRef.current = window.setTimeout(resetExpressionSafe, DANCE_MS)
  }

  const doIdleAct = () => {
    const roll = Math.random()
    if (roll < 0.34) {
      showExpression(REPLY_EXPRESSIONS[Math.floor(Math.random() * REPLY_EXPRESSIONS.length)], undefined, 3200)
      idleUntilRef.current = Date.now() + 3200
    } else if (roll < 0.64) {
      glanceAway()
      idleUntilRef.current = Date.now() + 3000
    } else {
      doDance()
    }
  }

  // 初始化:加载 Core → 创建透明 PIXI 舞台 → 加载模型并按容器尺寸适配
  useEffect(() => {
    let disposed = false
    let app: PIXI.Application | null = null
    let model: Live2DModelInstance | null = null

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
        // 每帧特效:拖动摆动 + 弹跳弹簧(互斥,不会同时发生)
        const onTick = () => {
          const m = modelRef.current
          if (!m || !readyRef.current) return
          const now = performance.now()
          if (draggingRef.current) {
            // 被拎着:身体按 ~1.1Hz 轻摆,头发物理自然跟随
            ;(m.internalModel.coreModel as ParamWriter).setParameterValueById(
              'ParamBodyAngleZ',
              Math.sin(now / 180) * 7,
            )
            swayDirtyRef.current = true
          } else if (swayDirtyRef.current) {
            swayDirtyRef.current = false
            ;(m.internalModel.coreModel as ParamWriter).setParameterValueById('ParamBodyAngleZ', 0)
          }
          const start = bounceAtRef.current
          const groundY = basePosRef.current.y
          if (start !== null) {
            const t = (now - start) / 1000
            const D = 0.5
            if (t >= D) {
              bounceAtRef.current = null
              m.scale.set(baseScaleRef.current)
              m.position.y = groundY
            } else {
              // 阻尼弹簧挤压回弹 + 一次小跳,脚底锚定不穿帮
              const sy = 1 - 0.14 * Math.exp(-4.2 * t) * Math.sin(13 * t)
              const hop = 13 * Math.sin((Math.PI * t) / D)
              m.scale.set(baseScaleRef.current * (1 - (sy - 1) * 0.9), baseScaleRef.current * sy)
              m.position.y = groundY - hop
            }
          }
          // QQ 形态过渡:参数档与支点位置同步滑向目标(约 0.2s),写作者的 QQ人 参数档
          const lv = qqLevelRef.current
          const target = qqTargetRef.current
          if (lv !== target) {
            const next = lv + Math.sign(target - lv) * Math.min(0.09, Math.abs(target - lv))
            qqLevelRef.current = next
            const core = m.internalModel.coreModel as ParamWriter
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
              m.position.set(bpTarget.x, bpTarget.y)
            } else {
              basePosRef.current = { x: nx, y: ny }
              m.position.set(nx, ny)
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
      window.clearTimeout(expressionTimerRef.current)
      model?.destroy({ children: true, texture: true, baseTexture: true })
      app?.destroy(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // 互动事件:点击反馈 / 拖动摆动开关 / AI 回复表情
  useEffect(() => {
    const onTap = () => {
      const [name, particle] = TAP_REACTIONS[Math.floor(Math.random() * TAP_REACTIONS.length)]
      showExpression(name, particle)
      bounceAtRef.current = performance.now()
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
      showExpression(REPLY_EXPRESSIONS[Math.floor(Math.random() * REPLY_EXPRESSIONS.length)])
    }
    // 右键菜单「动作」:指定表情或拿葱舞
    const onPlay = (e: Event) => {
      const detail = (e as CustomEvent).detail as { expression?: string; dance?: boolean } | undefined
      if (detail?.dance) {
        doDance()
        return
      }
      if (detail?.expression) showExpression(detail.expression, undefined, 3200)
    }
    // 双击切换 QQ 人形态:持续参数档,进出都带弹跳;变身后不受表情复位影响。
    // 同时平滑平移模型支点(站回按钮底沿)并通知外层缩放按钮盒。
    const onQQ = () => {
      if (!readyRef.current) return
      const entering = qqTargetRef.current === 0
      qqTargetRef.current = entering ? 1 : 0
      basePosTargetRef.current = entering ? { ...BASE_POS_QQ } : { ...BASE_POS_NORMAL }
      bounceAtRef.current = performance.now()
      spawnFx(entering ? '💢' : '✨', 4)
      onQQChange?.(entering)
    }
    window.addEventListener(MIKU_TAP_EVENT, onTap)
    window.addEventListener(MIKU_DRAG_START_EVENT, onDragStart)
    window.addEventListener(MIKU_DRAG_END_EVENT, onDragEnd)
    window.addEventListener(MIKU_EXPRESS_EVENT, onExpress)
    window.addEventListener(MIKU_QQ_EVENT, onQQ)
    window.addEventListener(MIKU_PLAY_EVENT, onPlay)
    return () => {
      window.removeEventListener(MIKU_TAP_EVENT, onTap)
      window.removeEventListener(MIKU_DRAG_START_EVENT, onDragStart)
      window.removeEventListener(MIKU_DRAG_END_EVENT, onDragEnd)
      window.removeEventListener(MIKU_EXPRESS_EVENT, onExpress)
      window.removeEventListener(MIKU_QQ_EVENT, onQQ)
      window.removeEventListener(MIKU_PLAY_EVENT, onPlay)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 闲置彩蛋:长时间没动静自己找乐子(小表情 / 看别处 / 拿葱舞);有动静立即收敛;可在「显示」菜单关闭
  useEffect(() => {
    let lastActive = Date.now()
    let lastAct = 0
    const markActive = () => {
      lastActive = Date.now()
      // 用户回来了:彩蛋立刻收场(动作最多再闪 2.7s 内部曲线,表情立即复原)
      if (Date.now() < idleUntilRef.current) {
        idleUntilRef.current = 0
        window.clearTimeout(expressionTimerRef.current)
        resetExpressionSafe()
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
      resetExpressionSafe()
      stopMotionSafe()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idleEnabled])

  // 绝对定位挂在按钮底部居中,不参与布局;ready 前无画布,不可见也不拦事件
  return (
    <div ref={hostRef} className="miku-stage" style={{ width: STAGE_W, height: STAGE_H }} aria-hidden="true">
      <div ref={fxRef} className="miku-fx" />
    </div>
  )
}
