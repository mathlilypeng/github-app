import dotenv from 'dotenv'
import fs from 'fs'
import http from 'http'
import { Octokit, App } from 'octokit'
import { createNodeMiddleware } from '@octokit/webhooks'
import { issueHandlers } from './webhook-handlers.js'
import { subscriptions } from './subscriptions.js'

// Load environment variables from .env file
dotenv.config()

// Set configured values
const appId = process.env.APP_ID
const privateKeyPath = process.env.PRIVATE_KEY_PATH
const privateKey = fs.readFileSync(privateKeyPath, 'utf8')
const secret = process.env.WEBHOOK_SECRET
const enterpriseHostname = process.env.ENTERPRISE_HOSTNAME

// Create an authenticated Octokit client authenticated as a GitHub App
const app = new App({
  appId,
  privateKey,
  webhooks: {
    secret
  },
  ...(enterpriseHostname && {
    Octokit: Octokit.defaults({
      baseUrl: `https://${enterpriseHostname}/api/v3`
    })
  })
})

// Optional: Get & log the authenticated app's name
const { data } = await app.octokit.request('/app')

// Read more about custom logging: https://github.com/octokit/core.js#logging
app.octokit.log.debug(`Authenticated as '${data.name}'`)

// Subscribe to the "issues.opened" webhook event.
// See https://docs.github.com/en/webhooks/webhook-events-and-payloads for more webhook events.
app.webhooks.on('issues.opened', issueHandlers.onIssueOpened)

// Optional: Handle errors
app.webhooks.onError((error) => {
  if (error.name === 'AggregateError') {
    // Log Secret verification errors
    console.log(`Error processing request: ${error.event}`)
  } else {
    console.error(`Recived error while handling Github App webhooks. Error: ${error}`)
  }
})

const buildResultSubscription = await subscriptions.createBobTheBuilderResultSubscription()
console.log(`Subscription created: ${buildResultSubscription.name}`);

const patchGenerationResultSubscription =
  await subscriptions.createPatchGenerationResultSubscription()
console.log(`Subscription created: ${patchGenerationResultSubscription.name}`);

// Launch a web server to listen for GitHub webhooks
const port = process.env.PORT || 3000
const path = '/api/webhook'
const localWebhookUrl = `http://localhost:${port}${path}`

// See https://github.com/octokit/webhooks.js/#createnodemiddleware for all options
const middleware = createNodeMiddleware(app.webhooks, { path })

http.createServer(middleware).listen(port, () => {
  console.log(`Server is listening for Github webhook events at: ${localWebhookUrl}`)
  console.log('Press Ctrl + C to quit.')
})
