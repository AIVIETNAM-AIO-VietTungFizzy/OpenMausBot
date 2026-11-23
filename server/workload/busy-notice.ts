import type { ServerText } from "../../shared/server-text.ts";

export const MODEL_BUSY_NOTICE = "chat.notice.modelBusy";

export const isModelBusy = (text: ServerText | undefined): boolean => text?.key === MODEL_BUSY_NOTICE;
