export type View =
  | { kind: 'ok'; source: 'draft' | 'sent' }
  | {
      kind: 'fix'
      source: 'draft' | 'sent'
      errors: {
        original: string
        corrected: string
        changes: { kind: string; why: string }[]
      }[]
    }

declare module 'claude-code' {
  interface PluginState {
    'language-improve': { view: View | null; muted: string[]; page: number }
  }
}
