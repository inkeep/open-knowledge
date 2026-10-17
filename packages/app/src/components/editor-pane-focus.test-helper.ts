export async function withUsableEditorHeader(
  callback: (button: HTMLButtonElement) => void | Promise<void>,
): Promise<void> {
  const button = document.body.appendChild(document.createElement('button'));
  button.type = 'button';
  button.setAttribute('data-header-pane-button', 'editor');
  Object.defineProperty(button, 'getClientRects', {
    configurable: true,
    value: () => [{ width: 1, height: 1 }],
  });
  button.focus();
  try {
    await callback(button);
  } finally {
    button.remove();
  }
}
