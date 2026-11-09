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

export interface ConfigFormSnapshot<T> {
  status: 'loading' | 'ready' | 'unavailable'
  value: T | undefined
  writable: boolean
  revision: number | undefined
}

export interface ConfigForm<T> {
  getSnapshot(): ConfigFormSnapshot<T>
  subscribe(listener: () => void): () => void
  set(field: string, value: unknown): Promise<boolean>
}

export interface ConfigFormsApi {
  get<T>(entryId: string): ConfigForm<T>
}

export interface ClientContext {
  effect: (factory: () => () => void, label?: string) => unknown
  slots: SlotsApi
  configForms: ConfigFormsApi
}

export type UseProjection = (key: string, selector?: (value: unknown) => unknown) => unknown

export interface SlotProps {
  readonly useProjection?: UseProjection
}
