import dotenv from 'dotenv'

// Set the NODE_ENV to 'development' by default
process.env.NODE_ENV = process.env.NODE_ENV || 'development'

dotenv.config()

export type Environment = {
  PG_CONNECTION_STRING: string | undefined
  LOG_LEVEL: string | undefined
  SUBSTRATE_URI: string | undefined
  PROCESS_EXTRINSICS: boolean
  PROCESS_EVENTS: boolean
  REST_API_PORT: number
  REST_API_BASIC_AUTH_PASSWORD: string
}

export const environment = {
  PG_CONNECTION_STRING: process.env.PG_CONNECTION_STRING,
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',
  APP_ID: process.env.APP_ID,
  SUBSTRATE_URI: process.env.SUBSTRATE_URI,
  PROCESS_EXTRINSICS: Boolean(process.env.PROCESS_EXTRINSICS) || true,
  PROCESS_EVENTS: Boolean(process.env.PROCESS_EVENTS) || false,
  REST_API_PORT: Number(process.env.REST_API_PORT) || 3000,
  REST_API_BASIC_AUTH_PASSWORD: process.env.REST_API_BASIC_AUTH_PASSWORD ?? 'password',
}
