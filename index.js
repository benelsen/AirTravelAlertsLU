/* eslint no-console: 0 */

import Twitter from 'twit'
import fetch from 'node-fetch'
import {
  compose, prop, map, curry, assoc, flatten, eqProps, propEq, propSatisfies,
  not, flip, contains, merge, slice, toUpper, adjust, join, props, ifElse,
} from 'ramda'
import moment from 'moment'
import util from 'util'
import Rx from 'rx'
import diff from 'fast-json-patch'
import fs from 'fs'
import path from 'path'

import {twitterCredentials, fetchInterval} from './data/config.json'

// Setup
const twitter = new Twitter(twitterCredentials)
const statePath = path.join(__dirname, 'data', 'state.json')

let initialState
try {
  initialState = JSON.parse( fs.readFileSync(statePath, 'utf8') )
} catch (e) {
  initialState = []
}

const momentiseDate = curry( (format, data) => moment(data, format) )
const hhmmDate = momentiseDate('HH:mm')

const responseJSON = (r) => r.json()
const dataURL = (type) => `https://api.luxair.lu/v2/flights/${type}`

const fetchDataType = (type) => fetch(dataURL(type))
  .then(responseJSON)
  .then(prop(type))
  .then(map(assoc('type', type)))

const dataTypes = ['departures', 'arrivals']
const fetchData = () => Promise.all(map(fetchDataType, dataTypes)).then(flatten)

const postTweet = Rx.Observable.fromCallback(
  (status, callback) => twitter.post('statuses/update', { status }, callback),
  twitter,
  (err, data) => data
)

const fakeTweet = status => ({created_at: moment.utc().format(), text: status, id_str: 0})

const fakePostTweet = Rx.Observable.fromCallback(
  (status, callback) => callback(null, fakeTweet(status)),
  twitter,
  (err, data) => data
)

const saveStateToDisk = data => {
  fs.writeFile(statePath, JSON.stringify(data, null, 2), err => {
    if (err) {
      return console.error('Error writing state to disk', err)
    }
    console.info(`Saved state to disk at ${moment.utc().format()}`)
  })
}

const dropLastOne = slice(0, -1)
const upperFirstOne = adjust(toUpper, 0)
const getTimeField = curry( (what, data) => prop(`${what}${compose(join(''), upperFirstOne, dropLastOne)(data.type)}`)(data) )

const calcTimeDiff = data => hhmmDate(getTimeField('estimated', data)).diff(hhmmDate(getTimeField('scheduled', data)), 'minutes')

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

const createEventType = data => {

  if ( data.flightStatus === 'Cancelled' ) {
    return assoc('status_type', 'cancelled', data)
  }

  const timeDiff = calcTimeDiff(data)
  if ( Math.abs(timeDiff) > 10 ) {

    return merge({
      status_type: `init_${timeDiff > 0 ? 'delayed' : 'early'}_${dropLastOne(data.type)}`,
      diff: timeDiff,
    }, data)
  }

  return assoc('status_type', 'as_scheduled', data)
}

const createTweets = data => {

  const diff = `${Math.abs(data.diff)} ${Math.abs(data.diff) === 1 ? 'minute' : 'minutes'}`
  const flightNumber = data.flightNumber.replace('-','')

  let text

  const via = data.viaAirport ? ` via ${data.viaAirport.name} #${data.viaAirport.code}` : ''
  const lateEarly = data.diff && data.diff <= 0 ? 'late' : 'early'

  switch (data.status_type) {
  case 'cancelled':
    if ( data.type === 'departures' ) {
      text = `Luxair flight #${flightNumber} to ${data.arrivalAirport.name} #${data.arrivalAirport.code}${via} at ${data.scheduledDeparture} has been cancelled.`
    } else {
      text = `Luxair flight #${flightNumber} from ${data.departureAirport.name} #${data.departureAirport.code}${via} at ${data.scheduledArrival} has been cancelled.`
    }
    break
  case 'init_delayed_departure':
  case 'init_early_departure':
    text = `Luxair flight #${flightNumber} to ${data.arrivalAirport.name} #${data.arrivalAirport.code}${via} is expected to depart ${diff} ${lateEarly} at ${data.estimatedDeparture} from gate ${data.terminal}${data.gate}.`
    break
  case 'init_delayed_arrival':
  case 'init_early_arrival':
    text = `Luxair flight #${flightNumber} from ${data.departureAirport.name} #${data.departureAirport.code}${via} is expected to arrive ${diff} ${lateEarly} at ${data.estimatedArrival}.`
    break
  }

  return merge({
    tweet: text,
    tweet_length: text.length,
  }, data)
}

const intervalStream = Rx.Observable.interval(fetchInterval).startWith(0)
const responseStream = intervalStream.flatMap(fetchData).startWith(initialState).tap(saveStateToDisk)
const changedFlights = responseStream.pairwise().flatMap(findChanges)
const delayedflights = changedFlights.filter(propSatisfies(compose(not, flip(contains)(['ARR', 'DEP'])), 'flightStatusCode'))
const eventstream = delayedflights.map(createEventType)
  .filter( compose(not, propEq('status_type', 'as_scheduled')) )

const isProduction = () => process.env.NODE_ENV === 'production'

const tweetSteam = eventstream.map(createTweets)
  .tap(console.log)
  .flatMap(compose(ifElse(isProduction, postTweet, fakePostTweet), prop('tweet')))

tweetSteam.subscribe(
  tweet => {
    if (tweet.errors) {
      return console.error( util.inspect(tweet, {depth: null, colors: true}))
    }
    console.log('tweeted:', join(' - ', props(['created_at', 'text', 'id_str'], tweet)) )
  },
  e => console.error('Error:', util.inspect(e, {depth: null, colors: true})),
  () => console.info('Completed')
)
