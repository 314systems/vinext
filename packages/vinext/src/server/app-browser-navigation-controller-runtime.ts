import { shouldScheduleRefreshForDiscardedServerAction } from "./app-browser-action-result.js";
import {
  FRESH_APP_NAVIGATION_PAYLOAD_ORIGIN,
  createPendingNavigationCommit,
} from "./app-browser-state.js";
import {
  applyApprovedVisibleCommit,
  approveHmrVisibleCommit,
  approvePendingNavigationCommit,
  resolveAndClassifyNavigationCommit,
} from "./app-browser-visible-commit.js";

export const navigationControllerRuntime = {
  FRESH_APP_NAVIGATION_PAYLOAD_ORIGIN,
  applyApprovedVisibleCommit,
  approveHmrVisibleCommit,
  approvePendingNavigationCommit,
  createPendingNavigationCommit,
  resolveAndClassifyNavigationCommit,
  shouldScheduleRefreshForDiscardedServerAction,
};
