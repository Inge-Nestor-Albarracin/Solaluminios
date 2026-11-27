import { describe, expect, it } from 'vitest';
import { ID_NUMBER_PATTERN, USERNAME_PATTERN, passwordProblem } from './password-policy.js';

describe('password policy', () => {
  it('accepts an own password with letters and digits', () => {
    expect(passwordProblem('Aluminio2026', 'pedro.alvarez')).toBeNull();
    expect(passwordProblem('ñandú2026', 'pedro.alvarez')).toBeNull();
  });

  it('refuses the ID number (only digits), short ones, letters only and the user name inside', () => {
    expect(passwordProblem('1032456789', 'pedro.alvarez')).toMatch(/letra y un número/);
    expect(passwordProblem('Ab12', 'pedro.alvarez')).toMatch(/al menos 8/);
    expect(passwordProblem('SoloLetras', 'pedro.alvarez')).toMatch(/letra y un número/);
    expect(passwordProblem('x.PEDRO.ALVAREZ.1', 'pedro.alvarez')).toMatch(/usuario/);
    expect(passwordProblem(`a1${'x'.repeat(127)}`, 'pedro.alvarez')).toMatch(/como máximo/);
  });

  it('user names: lowercase letters and digits with single separators; ID numbers: 5 to 12 digits', () => {
    for (const ok of ['pedro.alvarez', 'ana_2', 'luis-rey', 'qa.ventas', 'usuario.0a1b2c3d4e']) expect(USERNAME_PATTERN.test(ok)).toBe(true);
    for (const bad of ['Pedro', 'pedro álvarez', 'pedro..alvarez', '.pedro', 'pedro.', 'ñandu', "x' or 1=1"]) expect(USERNAME_PATTERN.test(bad)).toBe(false);
    for (const ok of ['12345', '1032456789', '123456789012']) expect(ID_NUMBER_PATTERN.test(ok)).toBe(true);
    for (const bad of ['1234', '1234567890123', '10.324.567', 'CC1032']) expect(ID_NUMBER_PATTERN.test(bad)).toBe(false);
  });
});
