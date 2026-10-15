/**
 * 开机自启（PRD P1-7 / 架构 A10）。
 *
 * 依赖: `electron` 的 `app.setLoginItemSettings()`。
 *
 * 【架构 A10 的关键决策】用官方 API 而**不是**写 `HKCU\...\Run` 注册表：
 *  - 官方 API 可卸载、跨版本稳定；
 *  - 免去注册表权限与残留项问题。
 *
 * 开发模式下（未打包）不能真正设置自启，否则每次 `npm run dev` 都会多一个 Electron 进程，
 * 因此开发模式只读不写，并在返回值中如实告知。
 */

import { app } from 'electron';

import type { Logger } from './logger';

export class AutoLaunchService {
  constructor(private readonly logger: Logger) {}

  /** 是否运行在打包后的环境（未打包时写自启无意义且会污染开发机）。 */
  private get isPackaged(): boolean {
    return app.isPackaged;
  }

  /** 读取当前自启状态。 */
  isEnabled(): boolean {
    try {
      const settings = app.getLoginItemSettings();
      return settings.openAtLogin;
    } catch (err) {
      this.logger.warn(`读取开机自启状态失败：${(err as Error).message}`);
      return false;
    }
  }

  /**
   * 设置开机自启。
   * @returns 实际设置结果（开发模式恒为 false 并已记录说明）。
   */
  setEnabled(enabled: boolean): boolean {
    if (!this.isPackaged) {
      this.logger.info('开发模式：跳过开机自启设置（需打包后的 exe 生效）');
      return false;
    }
    try {
      app.setLoginItemSettings({ openAtLogin: enabled, openAsHidden: true });
      this.logger.info(`开机自启已${enabled ? '开启' : '关闭'}`);
      return app.getLoginItemSettings().openAtLogin;
    } catch (err) {
      this.logger.error(`设置开机自启失败：${(err as Error).message}`);
      return false;
    }
  }

  /** 托盘菜单「开机自启」勾选项。 */
  toggle(): boolean {
    return this.setEnabled(!this.isEnabled());
  }
}
