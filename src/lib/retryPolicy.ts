/**
 * Attempts every item once. It deliberately returns only counts and successful
 * results so a UI can recover without exposing private transport errors.
 */
export async function retryAllInOrder<Input, Output>(
  items: readonly Input[],
  attempt: (item: Input) => Promise<Output>
): Promise<{ delivered: Output[]; failedCount: number }> {
  const delivered: Output[] = [];
  let failedCount = 0;

  for (const item of items) {
    try {
      delivered.push(await attempt(item));
    } catch {
      failedCount += 1;
    }
  }

  return { delivered, failedCount };
}
