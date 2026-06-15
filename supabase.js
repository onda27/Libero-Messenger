// js/supabase.js
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const SUPABASE_URL = 'https://udlhbakuqwvhiwblpmxj.supabase.co';
const SUPABASE_KEY = 'sb_publishable_Fy9ShwcK2NjDuyrzsxwh1w_2CTRdGgw';

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
