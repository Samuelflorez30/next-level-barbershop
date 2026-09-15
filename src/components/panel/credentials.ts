/**
 * Rellena la tarjeta de credenciales (CredentialsCard.astro) en el navegador:
 * usuario, contraseña temporal, botón Copiar y enlace de WhatsApp al barbero.
 */
import { buildPanelAccessMessage, buildWhatsAppUrl } from '../../lib/whatsapp';

export interface Credentials {
  username: string;
  password: string;
}

export interface FillCredentialsOptions {
  barberName: string;
  /** WhatsApp del barbero (solo dígitos, con indicativo). */
  phone: string;
  credentials: Credentials;
}

export function fillCredentials(card: HTMLElement, { barberName, phone, credentials }: FillCredentialsOptions) {
  card.querySelector<HTMLElement>('[data-cred-username]')!.textContent = credentials.username;
  card.querySelector<HTMLElement>('[data-cred-password]')!.textContent = credentials.password;

  const whatsapp = card.querySelector<HTMLAnchorElement>('[data-cred-whatsapp]')!;
  whatsapp.href = buildWhatsAppUrl(phone, buildPanelAccessMessage({ barberName, ...credentials }));

  const copy = card.querySelector<HTMLButtonElement>('[data-cred-copy]')!;
  copy.dataset.text = `Usuario: ${credentials.username}\nContraseña temporal: ${credentials.password}`;
  if (!copy.dataset.bound) {
    copy.dataset.bound = 'true';
    const original = copy.textContent;
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(copy.dataset.text ?? '');
        copy.textContent = 'Copiado ✓';
      } catch {
        copy.textContent = 'No se pudo copiar';
      }
      setTimeout(() => (copy.textContent = original), 2000);
    });
  }

  card.hidden = false;
}
