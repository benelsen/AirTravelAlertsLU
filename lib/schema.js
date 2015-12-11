
import joi from 'joi'

export const airportSchema = joi.object().keys({
  code: joi.string().length(3).optional(),
  name: joi.string().min(1).required(),
})
export const timeSchema = joi.string().regex(/\d{2}:\d{2}/)
export const flightNumberSchema = joi.string().regex(/^[A-Z0-9]{2}\d+/)

export const tweetSchema = joi.object().keys({
  tweet: joi.string().min(20).max(140).required(),
  status_type: joi.string().required(),
  airlineName: joi.string().required(),
  flightNumber: flightNumberSchema.required(),
  diff: joi.number(),
  type: joi.string().valid('arrival', 'departure').required(),
  terminal: joi.string(),
  gate: joi.number(),

  departureAirport: airportSchema.when('type', {is: 'arrival', then: joi.required(), otherwise: joi.forbidden()}),
  estimatedArrival: timeSchema.when('type', {is: 'arrival', then: joi.required(), otherwise: joi.forbidden()}),
  scheduledArrival: timeSchema.when('type', {is: 'arrival', then: joi.required(), otherwise: joi.forbidden()}),

  arrivalAirport: airportSchema.when('type', {is: 'departure', then: joi.required(), otherwise: joi.forbidden()}),
  estimatedDeparture: timeSchema.when('type', {is: 'departure', then: joi.required(), otherwise: joi.forbidden()}),
  scheduledDeparture: timeSchema.when('type', {is: 'departure', then: joi.required(), otherwise: joi.forbidden()}),

  viaAirport: airportSchema,
})
