export type View =
  | { kind: 'ok'; source: 'draft' | 'sent' }
  | {
      kind: 'fix'
      source: 'draft' | 'sent'
      original: string
      corrected: string
      why: string
      more: number
    }

declare module 'claude-code' {
  interface PluginState {
    'language-improve': { view: View | null }
  }
}
