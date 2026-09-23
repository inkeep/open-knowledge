export function openFilePicker({
  multiple,
  onFiles,
}: {
  multiple: boolean;
  onFiles: (files: readonly File[]) => Promise<void> | void;
}): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = multiple;
  input.addEventListener(
    'change',
    () => {
      const files = Array.from(input.files ?? []);
      if (files.length > 0) void onFiles(files);
    },
    { once: true },
  );
  input.click();
}
