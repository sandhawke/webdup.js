const debug = require('debug')(__filename.split('/').slice(-1).join())
let streamNumbers = 0

const handleStream = ({dataset, stringify}, req, res) => {
  const streamNumber = ++streamNumbers
  debug('stream open %d', streamNumber)
  console.log('stream open %d', streamNumber)

  // Obviously we're messing with internals, but I don't know a proper
  // way to lower the highwatermark on a socket created by
  // http.Server, and we want it low, because we can buffer MUCH
  // better.
  // console.log('res.socket %O', res.socket)
  if (res.socket._writableState.highWaterMark) {
    res.socket._writableState.highWaterMark = 1024
  } else {
    throw Error('res._writableState.highWaterMark missing -- library version issue?')
  }

  // When the clien closes the connection, we need to stop listening
  // to changes on this dataset
  req.on('close', () => {
    debug('stream CLOSED by client %d', streamNumber)
    dataset.off('change', onChange)
  })

  // Very simple header.  Could also link back to full-content resource?
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache'
  })
  
  const addQ = dataset.emptyClone()
  const deleteQ = dataset.emptyClone()
  let flowing = true
  let smart = true

  let id = () => ''

  const onClear = () => {
    debug('during clear, stream %d', streamNumber)
    // go ahead and push this through even if not flowing; I think
    // that makes more sense than trying to queue this somehow.
    addQ.clear()
    deleteQ.clear()
    flowing = res.write(id() + 'event: remove-all\n\n')
  }
  
  const onAdd = item => {
    debug('during add %o, stream %d', item, streamNumber)
    if (flowing) {
      if (!dataset.has(item)) console.error('onAdd sees we DO NOT have item')
      flowing = res.write(id() + 'event: add\ndata: ' + stringify(item).replace('\n', '\ndata: ') + '\n\n')
    } else {
      if (smart) {
        const wasInDeleteQ = deleteQ.delete(item)
        if (!wasInDeleteQ) addQ.add(item)
      } else {
        addQ.add(item)
      }
    }
  }
  
  const onDelete = key => {
    debug('during remove %o, stream %d', key, streamNumber)
    if (flowing) {
      // if (dataset.has(item)) console.error('onDelete sees we have item')
      flowing = res.write(id() + 'event: remove\ndata: ' +
                          key.replace('\n', '\ndata: ') +
                          '\n\n')
      // res.socket.bufferSize is the same thing
      // if (res.socket.writableLength > 107) console.log('hw=%o, len=%o', res.socket.writableHighWaterMark, res.socket.writableLength)
    } else {
      if (smart) {
        const wasInAddQ = addQ.deleteKey(key)
        if (!wasInAddQ) deleteQ.add(key)
      } else {
        deleteQ.add(key)
      }
    }
  }

  const onChange = event => {
    if (event.type === 'clear') {
      onClear()
    } else if (event.type === 'add') {
      onAdd(event.item)
    } else if (event.type === 'delete') {
      onDelete(event.key)
    }
  }
  dataset.on('change', onChange)



  // If we got back-pressure during a res.write, and flowing was set
  // to false, we're supposed to get a 'drain' event as soon as it's
  // good to send again.
  res.on('drain', () => {
    // process.stdout.write('.')
    console.log('Draining with ', {deleteQ:[...deleteQ.values()],
                                   addQ:[...addQ.values()]})
    flowing = true
    
    const flush = (q, func) => {
      while (flowing) {
        // pick any value from the queue
        let {value, done} = q.values().next()
        if (done) break
        // remove it from the queue and try again to send it
        q.delete(value)
        func(value)
      }
    }

    flush(deleteQ, onDelete)
    flush(addQ, onAdd)

  })

  // Start off with no knowledge of the client's version, so we need
  // to wipe it.
  //
  // don't send ids on these, because the dataset.etag wont reflect
  // the partial state.   
  onClear()
  for (const i of dataset) onAdd(i)

  // okay, now we can set etags as ids
  id = () => {
    let etag = dataset.etag
    if (etag) return 'id: ' + etag + '\n'
    return ''
  }
}

module.exports = handleStream
