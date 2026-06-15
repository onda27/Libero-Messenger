// js/crypto.js
export const CryptoManager = {
    // Генерация ключей для ECDH (обмен ключами)
    async generateECDHKeyPair() {
        return await window.crypto.subtle.generateKey(
            { name: "ECDH", namedCurve: "P-256" },
            true,
            ["deriveKey"]
        );
    },

    // Шифрование сообщения (AES-GCM)
    async encryptMessage(text, sharedSecret) {
        const encoder = new TextEncoder();
        const iv = window.crypto.getRandomValues(new Uint8Array(12));
        const encrypted = await window.crypto.subtle.encrypt(
            { name: "AES-GCM", iv: iv },
            sharedSecret,
            encoder.encode(text)
        );
        return { encrypted, iv };
    },

    // Дешифровка
    async decryptMessage(encryptedData, iv, sharedSecret) {
        const decrypted = await window.crypto.subtle.decrypt(
            { name: "AES-GCM", iv: iv },
            sharedSecret,
            encryptedData
        );
        return new TextDecoder().decode(decrypted);
    }
};
