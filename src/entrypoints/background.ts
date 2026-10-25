import { defineBackground } from 'wxt/utils/define-background';
import { startBackgroundHost } from '../extension/background-host';

export default defineBackground(() => {
  startBackgroundHost();
});
