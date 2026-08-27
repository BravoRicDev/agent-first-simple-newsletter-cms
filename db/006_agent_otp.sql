-- Aggiunge indice su (user_id, otp) per la verifica OTP-only da CLI
CREATE INDEX IF NOT EXISTS idx_magic_links_user_otp ON magic_links(user_id, otp);
