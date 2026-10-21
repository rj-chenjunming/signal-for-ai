import { expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ Notification: class { static isSupported() { return true; } } }));
import { Notifier } from '../src/main/notify';
import { DEFAULT_NOTIFY_SETTINGS } from '../src/shared/constants';
import { TaskStore } from '../src/main/store';
import type { Logger } from '../src/main/logger';
it('confirmed absence does not notify even when idle is explicitly in the notification whitelist', () => {
  const store = new TaskStore([{ id: 'd', name: 'd', enabled: true, monitor: { type: 'dsh', authority: 'auto' } }]);
  const playSound = vi.fn();
  const notifier = new Notifier({ settings: { ...DEFAULT_NOTIFY_SETTINGS, popup: false, sound: true,
    soundOnlyOnFailure: false, notifyStates: ['idle'] }, logger: { info: vi.fn() } as unknown as Logger,
    playSound, onAction: vi.fn() });
  store.onChange((snapshot, changes) => notifier.onStoreChange(snapshot, changes));
  store.apply('d', { processPresent: false, message: '未运行，等待启动' });
  expect(playSound).not.toHaveBeenCalled();
});
