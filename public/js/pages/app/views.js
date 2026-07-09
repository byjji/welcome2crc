/* ============================================================
   pages/app/views.js — 크루 공간 화면(뷰) 전환
   loading / config / login / pending / rejected / app
   ============================================================ */
import { $ } from "../../lib/ui.js";

const views = {
  loading: $("viewLoading"),
  config: $("viewConfig"),
  login: $("viewLogin"),
  pending: $("viewPending"),
  rejected: $("viewRejected"),
  app: $("viewApp"),
};

export function showView(name) {
  Object.entries(views).forEach(([k, el]) => (el.hidden = k !== name));
}
