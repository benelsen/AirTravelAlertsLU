
import fetch from 'node-fetch'
import { prop, map, assoc, flatten } from 'ramda'

const dataURLLuxair = (type) => `https://api.luxair.lu/v2/flights/${type}`

const responseJSON = (r) => r.json()
const fetchDataType = (type) => fetch(dataURLLuxair(`${type}s`))
  .then(responseJSON)
  .then(prop(`${type}s`))
  .then(map(assoc('type', type)))

const dataTypes = ['departure', 'arrival']
const fetchData = () => Promise.all(map(fetchDataType, dataTypes)).then(flatten)

export default fetchData
