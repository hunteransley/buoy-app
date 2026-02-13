import { createClient } from '@supabase/supabase-js'
const supabaseUrl = 'https://xlnxuaigmutbfnzkmihz.supabase.co'
const supabaseAnonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inhsbnh1YWlnbXV0YmZuemttaWh6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA5OTQ1ODQsImV4cCI6MjA4NjU3MDU4NH0.lU1nQYUR5GjZuyDSgypTr0_0XI7UX6TDiqsh0pcPt4A'
export const supabase = createClient(supabaseUrl, supabaseAnonKey)
