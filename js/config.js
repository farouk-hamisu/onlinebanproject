// NationalRegionB — Client configuration
// Replace these values with your Supabase project credentials.
// ONLY the public anon key belongs here. Never expose the service_role key.
const APP_CONFIG = {
  supabaseUrl: 'https://nwhvjdyalnanyvwiagap.supabase.co',
  supabaseAnonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im53aHZqZHlhbG5hbnl2d2lhZ2FwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY4MzA2NjQsImV4cCI6MjEwMjQwNjY2NH0._s7ls8PWnaBFE24XsE-UJvmlVVdLRS02D-w8owXz79w',
  bankName: 'NationalRegionB',
  currencySymbols: {
    USD: '$', EUR: '€', GBP: '£', NGN: '₦', CAD: 'C$'
  },
  pageSize: 10
};