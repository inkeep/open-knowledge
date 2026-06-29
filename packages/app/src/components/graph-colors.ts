
const DARK_PALETTE = [
  '#60a5fa', // Blue      - Knowledge, concepts, structure
  '#a78bfa', // Violet    - Research, analysis, methodology
  '#34d399', // Emerald   - Systems, frameworks, architecture
  '#f472b6', // Pink      - Creative, novel, breakthrough ideas
  '#fb923c', // Orange    - Processes, workflows, execution
  '#22d3ee', // Cyan      - Data, information, retrieval
  '#c084fc', // Purple    - Memory, cognition, intelligence
  '#4ade80', // Green     - Learning, adaptation, evolution
  '#f87171', // Red       - Challenges, gaps, critique
  '#eab308', // Yellow    - Insights, discoveries, patterns
  '#ec4899', // Hot Pink  - Innovation, experimentation
  '#06b67f', // Teal      - Integration, synthesis, connections
  '#8b5cf6', // Indigo    - Theory, abstraction, foundations
  '#f43f5e', // Rose      - Evaluation, assessment, quality
  '#0ea5e9', // Sky       - Exploration, discovery, frontiers
  '#a855f7', // Fuchsia   - Interdisciplinary, synthesis
] as const;

const LIGHT_PALETTE = [
  '#1e40af', // Deep Blue     - Knowledge, concepts, structure
  '#6b21a8', // Deep Violet   - Research, analysis, methodology
  '#166534', // Deep Green    - Systems, frameworks, architecture
  '#9f1239', // Deep Rose     - Creative, novel, breakthrough ideas
  '#9a3412', // Deep Orange   - Processes, workflows, execution
  '#164e63', // Deep Cyan     - Data, information, retrieval
  '#581c87', // Deep Purple   - Memory, cognition, intelligence
  '#166534', // Forest Green  - Learning, adaptation, evolution
  '#991b1b', // Deep Red      - Challenges, gaps, critique
  '#854d0e', // Deep Amber    - Insights, discoveries, patterns
  '#831843', // Deep Pink     - Innovation, experimentation
  '#0f766e', // Deep Teal     - Integration, synthesis, connections
  '#312e81', // Deep Indigo   - Theory, abstraction, foundations
  '#9f1239', // Deep Rose     - Evaluation, assessment, quality
  '#0c4a6e', // Deep Sky      - Exploration, discovery, frontiers
  '#6b21a8', // Deep Purple   - Interdisciplinary, synthesis
] as const;

function stableHash(str: string): number {
  let h = 2;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 0x5bd1e995);
    h ^= h >>> 13;
    h = Math.imul(h, 0x5bd1e995);
    h ^= h >>> 15;
  }
  return h >>> 0;
}

export function clusterColor(cluster: string, isDark: boolean): string {
  const palette = isDark ? DARK_PALETTE : LIGHT_PALETTE;
  return palette[stableHash(cluster) % palette.length];
}
