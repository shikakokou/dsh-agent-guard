// 只声明本插件用到的宿主接口，不依赖 DSH 包类型。

export interface SlotRegisterOptions {
  name: string
  id: string
  order?: number
}

export interface SlotsApi {
  inject: (name: string, register: () => unknown) => unknown
  register: (options: SlotRegisterOptions, component: unknown) => unknown
}

export interface ClientContext {
  effect: (factory: () => () => void, label?: string) => unknown
  slots: SlotsApi
}

export type UseProjection = (key: string, selector?: (value: unknown) => unknown) => unknown

export interface SlotProps {
  readonly useProjection?: UseProjection
}
