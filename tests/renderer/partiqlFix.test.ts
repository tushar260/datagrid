import { describe, expect, it } from 'vitest'
import { suggestPartiqlFix } from '../../src/renderer/src/lib/partiqlFix'

const fix = (w: string): string | undefined => suggestPartiqlFix(w)?.fixedWhere

describe('suggestPartiqlFix', () => {
  it('moves the attribute into begins_with(...) (the reported case)', () => {
    const h = suggestPartiqlFix("PK = 'employee#scrut-dev' and SK begins_with('tusharaorora@scrut.io')")!
    expect(h.fixedWhere).toBe("PK = 'employee#scrut-dev' and begins_with(SK, 'tusharaorora@scrut.io')")
    expect(h.message).toBe("`SK begins_with('tusharaorora@scrut.io')` is not valid PartiQL: the attribute goes inside the function. Use `begins_with(SK, 'tusharaorora@scrut.io')`")
  })

  it('works for contains / attribute_type, quoted attributes and any letter case', () => {
    expect(fix(`"my attr" contains('x')`)).toBe(`contains("my attr", 'x')`)
    expect(fix(`tags CONTAINS ('x')`)).toBe(`CONTAINS(tags, 'x')`)
    expect(fix(`a attribute_type('S')`)).toBe(`attribute_type(a, 'S')`)
  })

  it('fixes every occurrence and keeps the rest of the text untouched', () => {
    expect(fix("a begins_with('x')  and  b contains('y') or c = 1")).toBe("begins_with(a, 'x')  and  contains(b, 'y') or c = 1")
  })

  it('ignores parentheses and commas inside string literals and nested calls', () => {
    expect(fix("sk begins_with('a)(,b')")).toBe("begins_with(sk, 'a)(,b')")
    expect(fix("sk begins_with(concat('a', 'b'))")).toBe("begins_with(sk, concat('a', 'b'))")
  })

  it('handles an empty argument list', () => {
    expect(fix('sk begins_with()')).toBe('begins_with(sk)')
  })

  it('returns null for valid PartiQL and for unrelated text', () => {
    expect(suggestPartiqlFix("begins_with(sk, 'x')")).toBeNull()
    expect(suggestPartiqlFix("pk = 'a' and contains(tags, 'x')")).toBeNull()
    expect(suggestPartiqlFix("pk = 'sk begins_with(x)'")).toBeNull() // inside a string literal
    expect(suggestPartiqlFix('')).toBeNull()
    expect(suggestPartiqlFix('sk begins_with(')).toBeNull() // unbalanced: nothing safe to rewrite
  })
})
