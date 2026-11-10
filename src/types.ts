
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

export interface LocaleDict {
  readonly [key: string]: string
}

export type Translate = (key: string, params?: Record<string, unknown>) => string

export interface LocaleService {
  register: (namespace: string, dictionaries: Record<string, LocaleDict>) => () => void
  bind: (namespace: string) => Translate
  subscribe: (listener: () => void) => () => void
  getSnapshot: () => { revision: number }
}

export interface ClientContext {
  effect: (factory: () => () => void, label?: string) => unknown
  slots: SlotsApi
  configForms: ConfigFormsApi
  locale: LocaleService
}

export type UseProjection = (key: string, selector?: (value: unknown) => unknown) => unknown

export interface SlotProps {
  readonly useProjection?: UseProjection
}
