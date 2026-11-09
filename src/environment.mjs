// Preserve existing launch configurations while Aurora adopts its new name.
// An explicit AURORA_ value, including an empty string, always takes precedence.
for (const [key, value] of Object.entries(process.env)) {
  if (key.startsWith('ASTER_')) process.env['AURORA_' + key.slice(6)] ??= value;
}
