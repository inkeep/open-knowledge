export function Ratio({ a, b }: { a: number; b: number }) {
  return (
    <div title="a // b">
      {a} // {b}
      <span>{/* a real JSX comment that must fire */}</span>
    </div>
  );
}

export const divide = (a: number, b: number) => a / b;
