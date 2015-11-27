
import {compose, drop, map, prop, slice, assoc, adjust, toUpper, toPairs, append, unnest, join, isEmpty} from 'ramda'
import {jsdom} from 'jsdom'
import fetch from 'node-fetch'

const urls = {
  departure: 'http://www.lux-airport.lu/en/Flights-information/Todays-departure.9.html',
  arrival: 'http://www.lux-airport.lu/en/Flights-information/Todays-arrivals.10.html',
}

const responseText = (r) => r.text()

const scrape = document => {
  const tableLines = Array.from( document.querySelectorAll('table.fly tr') )
  const dataLines = drop(1, tableLines)
  const tds = dataLines.map(e => Array.from( e.querySelectorAll('td') ) )
  const data = tds.map(map(prop('textContent')))
  return data
}

const fetchData = () => Promise.all( map(fetchDataType, toPairs(urls)) ).then(unnest).then(map(createObject))
const fetchDataType = ([type, url]) => fetch(url).then(responseText).then(jsdom).then(scrape).then(map(append(type)))

const statusMapping = {
  'Take Off': ['Departed', 'DEP'],
  'Arrived': ['Landed', 'ARR'],
  'Landing': ['Estimated', 'EXP'],
  'Taxiing': ['Departed', 'DEP'],
  'Expected': ['Estimated', 'EXP'],
  'Delayed': ['Estimated', 'EXP'],
  'Cancelled': ['Cancelled', 'CNX'],
  '': ['Expected', 'PLN'],
}

const upperFirstOne = compose( join(''), adjust(toUpper, 0))

const createObject = (f) => {

  let obj = {
    airlineIATA: slice(0, 2, f[1]),
    airlineName: f[7],
    flightNumber: f[1],
    flightStatus: f[4],
    flightStatusCode: null,
    gate: null,
    terminal: null,
    type: f[8],
    aircraftType: f[6],
  }

  const type = f[8]

  obj = compose(
    assoc(`scheduled${upperFirstOne(type)}`, f[3]),
    assoc(`estimated${upperFirstOne(type)}`, !isEmpty(f[5]) ? f[5] : f[3]),
    assoc(type === 'departure' ? 'arrivalAirport' : 'departureAirport', { code: null, name: f[0] })
  )(obj)

  const status = statusMapping[f[4]] || ['Unknown', 'UKN']
  obj = compose(assoc('flightStatus', status[0]), assoc('flightStatusCode', status[1]))(obj)

  if ( !isEmpty(f[2]) ) {
    obj = assoc('via', { code: null, name: f[2] }, obj)
  }

  return obj
}

export default fetchData
