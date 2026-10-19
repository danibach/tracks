// Réglages du site. Toutes ces valeurs sont publiques par conception :
// la sécurité repose sur les règles d'accès de Supabase et sur la fonction d'envoi.
export const CONFIG = {
  SITE_NAME: 'Traces',
  SUPABASE_URL: 'https://fjwsmdglbnmmelfamyol.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_lQGLe10NlBKFSLz6sapaKg_cgzjH_Hv',
  TURNSTILE_SITE_KEY: '0x4AAAAAAFbn5gcuFqJjtp_L',
  MAX_FILE_MB: 6,
  // Adresse affichée dans « Données et confidentialité » pour demander le retrait d'une trace.
  // Laisser vide tant qu'elle n'est pas choisie.
  CONTACT_EMAIL: '',
};
