// js/storage.js
import { supabase } from './supabase.js';

export const uploadEncryptedFile = async (file, path) => {
    // 1. Шифрование происходит ДО этого вызова (через Web Crypto)
    // 2. Отправляем в Supabase
    const { data, error } = await supabase.storage
        .from('chat-files') // Имя вашего бакета
        .upload(path, file);

    if (error) throw error;
    return data;
};
