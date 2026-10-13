export type View =
  | { kind: 'ok'; source: 'draft' | 'sent' }
  | {
      kind: 'fix'
      source: 'draft' | 'sent'
      text: string
      errors: {
        original: string
        corrected: string
        changes: { kind: string; why: string; words?: string }[]
      }[]
    }

declare module 'claude-code' {
  interface PluginState {
    'language-improve': { view: View | null; muted: string[]; expanded: boolean }
  }
}
