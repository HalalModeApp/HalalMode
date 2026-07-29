import type { Profile } from '@/types';

/** Maps only fields the general profile RPC is allowed to mutate. */
export function profilePatchToRow(patch: Partial<Profile>): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  const fields: [keyof Profile, string][] = [
    ['name', 'name'],
    ['firstName', 'first_name'],
    ['occupation', 'occupation'],
    ['education', 'education'],
    ['bio', 'bio'],
    ['chips', 'chips'],
    ['religiousPractice', 'religious_practice'],
    ['timeline', 'timeline'],
    ['relocation', 'relocation'],
    ['familyGoals', 'family_goals'],
    ['languagesSpoken', 'languages_spoken'],
  ];
  for (const [property, column] of fields) {
    if (patch[property] !== undefined) row[column] = patch[property];
  }
  return row;
}
