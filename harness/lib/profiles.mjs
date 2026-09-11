// CLI coverage names. Keep the existing internal reduced-pair flag for High.
export function profileOptions(flags) {
  const selected = ['simple', 'high', 'xhigh'].filter(name => flags[name]);
  if (selected.length > 1) throw new Error('Choose one profile: --simple, --high or --xhigh.');
  if (!flags.high && !flags.xhigh) return flags;
  if (flags.config || flags['model-checks'] || flags['follow-up']) throw new Error('High/XHigh cannot combine with custom Simple config or the separate model-check profile.');
  if (flags.high && flags.required) throw new Error('--high cannot be combined with --required; use --xhigh --required.');
  if (flags.mode && flags.mode !== 'registry') throw new Error('High/XHigh include upgrade checks and require registry mode.');
  return { ...flags, simple: Boolean(flags.high), mode: 'registry', upgrade: true };
}
