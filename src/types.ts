/** 宿主注入到槽位组件的 kit 与本插件用到的客户端上下文，最小声明。 */

/** 槽位注册选项。 */
export interface SlotRegisterOptions {
  name: string
  id: string
  order?: number
}

/** 客户端槽位服务面。 */
export interface SlotsApi {
  inject: (name: string, register: () => unknown) => unknown
  register: (options: SlotRegisterOptions, component: unknown) => unknown
}

/** 客户端插件上下文；只声明本插件用到的字段。 */
export interface ClientContext {
  effect: (factory: () => () => void, label?: string) => unknown
  slots: SlotsApi
}

/** 会话投影读取函数（宿主 kit 提供）。 */
export type UseProjection = (key: string, selector?: (value: unknown) => unknown) => unknown

/** 槽位组件从宿主 kit 收到的 props；本插件只用到 useProjection。 */
export interface SlotProps {
  readonly useProjection?: UseProjection
}
