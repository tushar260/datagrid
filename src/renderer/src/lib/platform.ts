/** True on macOS (read at call time, so tests can mock navigator.platform). */
export const isMac = (): boolean => /Mac|iPhone|iPad/.test(navigator.platform)
