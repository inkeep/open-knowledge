export default function failingGlobalSetup(): void {
  throw new Error('global setup failed on purpose');
}
