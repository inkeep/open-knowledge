const GRADIENTS = [
  'from-[#ff9d6c] to-[#ff7eb3]',
  'from-[#8fe0c0] to-[#59c0ff]',
  'from-[#c0b0ff] to-[#8fb0ff]',
  'from-[#ffd18f] to-[#ff9fb0]',
  'from-[#8fb0ff] to-[#c9a8ff]',
  'from-[#7fe0a0] to-[#bfe08f]',
] as const;

export function skillTint(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return GRADIENTS[Math.abs(h) % GRADIENTS.length] ?? GRADIENTS[0];
}
