import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Modal, Text } from '@tidbcloud/uikit';

export function WorkspaceModal({
  title,
  description,
  children,
  onClose,
  wide = false,
  size,
  busy = false,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
  size?: number;
  busy?: boolean;
}) {
  // These dialogs unmount on close; TiUI's opened-state transition cannot return focus then.
  const [trigger] = useState(() => document.activeElement);
  useEffect(
    () => () => {
      if (trigger instanceof HTMLElement && trigger.isConnected)
        trigger.focus({ preventScroll: true });
    },
    [trigger],
  );
  return (
    <Modal
      opened
      onClose={() => {
        if (!busy) onClose();
      }}
      title={title}
      size={size ?? (wide ? 900 : 680)}
      padding={24}
      centered
      closeButtonProps={{ 'aria-label': 'Close dialog', size: 44, disabled: busy }}
      trapFocus
      returnFocus
      closeOnEscape={!busy}
      closeOnClickOutside={!busy}
    >
      {description && (
        <Text c="carbon.7" mb={24}>
          {description}
        </Text>
      )}
      {children}
    </Modal>
  );
}
