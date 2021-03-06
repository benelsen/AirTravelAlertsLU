
import {
  compose, prop, map, curry, assoc, eqProps, propEq, propSatisfies, over, lensProp, union, gte, curryN,
  replace, not, flip, contains, merge, toUpper, adjust, join, props, ifElse, split, filter, equals, nthArg, identity, concat, __,
} from 'ramda'
import Twitter from 'twit'
import moment from 'moment'
import diff from 'fast-json-patch'
import joi from 'joi'
import Rx from 'rx'
import winston from 'winston'

import fs from 'fs'
import path from 'path'

import fetchLuxair from './luxair'
import fetchLuxAirport from './luxairport'
import * as schema from './schema'

import {twitterCredentials, fetchInterval} from '../data/config.json'

// Logging
const logger = new winston.Logger({
  transports: [
    new winston.transports.Console({ level: 'info' }),
    new winston.transports.File({ name: 'verbose-file', filename: 'data/verbose.log', level: 'verbose' }),
    new winston.transports.File({ name: 'warn-file', filename: 'data/warn.log', level: 'warn' }),
  ],
})

// Setup
const twitter = new Twitter(twitterCredentials)
const statePath = path.join(__dirname, '..', 'data', 'state.json')

let initialState
try {
  initialState = JSON.parse( fs.readFileSync(statePath, 'utf8') )
} catch (e) {
  initialState = []
}

const momentiseDate = curry( (format, data) => moment(data, format) )
const hhmmDate = momentiseDate('HH:mm')

const postTweet = Rx.Observable.fromCallback(
  (status, callback) => twitter.post('statuses/update', { status }, callback),
  twitter,
  (err, data) => data
)

const fakePostTweet = Rx.Observable.fromCallback(
  (status, callback) => callback(null, {created_at: moment.utc().format(), text: status, id_str: 0}),
  twitter,
  (err, data) => data
)

const saveStateToDisk = data => {
  fs.writeFile(statePath, JSON.stringify(data, null, 2), err => {
    if (err) {
      return logger.error('Error writing state to disk', err)
    }
    logger.verbose(`Saved state to disk at ${moment.utc().format()}`)
  })
}

const upperFirstOne = compose(join(''), adjust(toUpper, 0))

const calcTimeDiff = data => {
  const scheduled = hhmmDate(prop(`scheduled${upperFirstOne(data.type)}`, data))
  let estimated = hhmmDate(prop(`estimated${upperFirstOne(data.type)}`, data))

  if ( estimated.isBefore(scheduled.clone().subtract(6, 'hours')) ) {
    estimated.add(1, 'day')
  }

  return estimated.diff(scheduled, 'minutes')
}

const findChanges = ([previous, current]) => {

  return current.reduce((arr, data) => {

    const previousData = previous.find(eqProps('flightNumber', data))
    if ( !previousData ) {
      return [...arr, data]
    }

    const changes = diff.compare(previousData, data)
    if ( changes.length === 0 ) {
      return arr
    }

    return [...arr, compose( assoc('previous', previousData), assoc('changes', changes) )(data)]
  }, [])
}

const gteAbs = (a, b) => gte(Math.abs(a), Math.abs(b))
const isDeparture = propEq('type', 'departure')
const isArrival = propEq('type', 'arrival')
const pluraliseByAppendingS = curryN(2, ifElse(compose(equals(1), Math.abs, nthArg(1)), identity, concat(__, 's')) )
const pluraliseMinute = pluraliseByAppendingS('minute')

const createEventType = data => {

  if ( data.flightStatus === 'Cancelled' ) {
    return assoc('status_type', 'cancelled', data)
  }

  const timeDiff = calcTimeDiff(data)
  data = assoc('diff', timeDiff, data)

  // Arrivals w/ Δt ≥ 15 min & Departures w/ Δt ≥ 30
  if ( (gteAbs(timeDiff, 15) && isArrival(data)) || (gteAbs(timeDiff, 30) && isDeparture(data)) ) {
    const status = `${data.changes ? 'initial' : 'change'}_${timeDiff <= 0 ? 'early' : 'delayed'}_${data.type}`
    return assoc('status_type', status, data)
  }

  return assoc('status_type', 'as_scheduled', data)
}

const createTweets = data => {

  const diff = `${Math.abs(data.diff)} ${pluraliseMinute(data.diff)}`

  const viaAirportCode = data.viaAirport && data.viaAirport.code ? ` #${data.viaAirport.code}` : ''
  const arrivalAirportCode = data.arrivalAirport && data.arrivalAirport.code ? ` #${data.arrivalAirport.code}` : ''
  const departureAirportCode = data.departureAirport && data.departureAirport.code ? ` #${data.departureAirport.code}` : ''

  const via = data.viaAirport ? ` via ${data.viaAirport.name}${viaAirportCode}` : ''

  const gate = data.gate && data.terminal ? ` from gate ${data.terminal}${data.gate}` : ''

  const lateEarly = data.diff && data.diff <= 0 ? 'early' : 'late'

  let text

  switch (data.status_type) {
  case 'cancelled':
    if ( data.type === 'departure' ) {
      text = `${data.airlineName} flight #${data.flightNumber} to ${data.arrivalAirport.name}${arrivalAirportCode}${via} at ${data.scheduledDeparture} has been cancelled.`
    } else {
      text = `${data.airlineName} flight #${data.flightNumber} from ${data.departureAirport.name}${departureAirportCode}${via} at ${data.scheduledArrival} has been cancelled.`
    }
    break
  case 'initial_delayed_departure':
  case 'initial_early_departure':
  case 'change_delayed_departure':
  case 'change_early_departure':
    text = `${data.airlineName} flight #${data.flightNumber} to ${data.arrivalAirport.name}${arrivalAirportCode}${via} is expected to depart ${diff} ${lateEarly} at ${data.estimatedDeparture}${gate}.`
    break
  case 'initial_delayed_arrival':
  case 'initial_early_arrival':
  case 'change_delayed_arrival':
  case 'change_early_arrival':
    text = `${data.airlineName} flight #${data.flightNumber} from ${data.departureAirport.name}${departureAirportCode}${via} is expected to arrive ${diff} ${lateEarly} at ${data.estimatedArrival}.`
    break
  }

  return merge({
    tweet: text,
    tweet_length: text.length,
  }, data)
}

const parseBase10Integer = (string) => parseInt(string, 10)

const normaliseFlightNumber = compose( join(''), adjust(parseBase10Integer, 1), split('-') )

const intervalStream = Rx.Observable.interval(fetchInterval).startWith(0)

const responseStreamLuxair = intervalStream.flatMap(fetchLuxair)
  .map(map(over(lensProp('flightNumber'), normaliseFlightNumber)))
  .map(map(over(lensProp('airlineName'), replace(/LUXAIR.*/i, 'Luxair'))))

const responseStreamLuxAirport = intervalStream.flatMap(fetchLuxAirport)
  .map(filter( f => f.airlineIATA !== 'LG' ))

const responseStream = Rx.Observable.combineLatest(responseStreamLuxair, responseStreamLuxAirport, union).startWith(initialState)
  .tap(saveStateToDisk)

const changedFlights = responseStream.pairwise().flatMap(findChanges)

const notArrivedDeparted = propSatisfies(compose(not, flip(contains)(['ARR', 'DEP'])), 'flightStatusCode')

const delayedflights = changedFlights.filter(notArrivedDeparted)

const eventstream = delayedflights.map(createEventType)
  .filter( compose(not, propEq('status_type', 'as_scheduled')) )

const isProduction = () => process.env.NODE_ENV === 'production'

const validTweet = tweet => {
  const result = joi.validate(tweet, schema.tweetSchema, {allowUnknown: true})
  if ( result.error ) {
    logger.warn( JSON.stringify(result.error) )
    return false
  }
  return true
}

const tweetSteam = eventstream.map(createTweets)
  // .tap(console.log)
  .filter( validTweet )
  .flatMap(compose(ifElse(isProduction, postTweet, fakePostTweet), prop('tweet')))

tweetSteam.subscribe(
  tweet => {
    if (tweet.errors) {
      return logger.warn( JSON.stringify(tweet) )
    }
    logger.info('tweeted:', join(' - ', props(['created_at', 'text', 'id_str'], tweet)) )
  },
  error => {
    logger.error(error)
    process.exit(8)
  },
  () => logger.info('Completed')
)
