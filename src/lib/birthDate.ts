export interface BirthDateParts {
  birthDay: string;
  birthMonth: string;
  birthYear: string;
}

export type BirthDateValidationIssue =
  | 'incomplete'
  | 'invalid'
  | 'too_young'
  | 'too_old';

/**
 * Native numeric keyboards can yield Arabic-Indic or Persian digits. Store
 * date parts canonically so the API receives one stable ISO date regardless
 * of the member's language or keyboard.
 */
export function normaliseDecimalDigits(value: string): string {
  return value
    .replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - 0x06f0))
    .replace(/\D/g, '');
}

export function formatBirthDate(parts: BirthDateParts): string | null {
  if (!parts.birthYear || !parts.birthMonth || !parts.birthDay) return null;
  return `${parts.birthYear.padStart(4, '0')}-${parts.birthMonth.padStart(2, '0')}-${parts.birthDay.padStart(2, '0')}`;
}

export function birthDateValidationIssue(
  parts: BirthDateParts,
  today: Date = new Date()
): BirthDateValidationIssue | null {
  const value = formatBirthDate(parts);
  if (!value) return 'incomplete';
  const date = new Date(`${value}T00:00:00`);
  const [year, month, day] = value.split('-').map(Number);
  if (
    Number.isNaN(date.getTime()) ||
    date.getFullYear() !== year ||
    date.getMonth() + 1 !== month ||
    date.getDate() !== day
  ) {
    return 'invalid';
  }
  const age = ageOnDate(date, today);
  if (age < 18) return 'too_young';
  if (age > 100) return 'too_old';
  return null;
}

/**
 * Returns the age shown to a member for a valid date of birth. Keeping this
 * alongside validation prevents the confirmation sheet from disagreeing with
 * the server-bound date format.
 */
export function ageForBirthDateParts(
  parts: BirthDateParts,
  today: Date = new Date()
): number | null {
  if (birthDateValidationIssue(parts, today)) return null;
  const value = formatBirthDate(parts);
  if (!value) return null;
  return ageOnDate(new Date(`${value}T00:00:00`), today);
}

export function ageOnDate(birthDate: Date, today: Date): number {
  let age = today.getFullYear() - birthDate.getFullYear();
  if (
    today.getMonth() < birthDate.getMonth() ||
    (today.getMonth() === birthDate.getMonth() && today.getDate() < birthDate.getDate())
  ) {
    age -= 1;
  }
  return age;
}
