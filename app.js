import dotenv from 'dotenv'
import fs from 'fs'
import http from 'http'
import { Octokit, App } from 'octokit'
import { createNodeMiddleware } from '@octokit/webhooks'
import { PubSub } from '@google-cloud/pubsub'

// Load environment variables from .env file
dotenv.config()

// Set configured values
const appId = process.env.APP_ID
const privateKeyPath = process.env.PRIVATE_KEY_PATH
const privateKey = fs.readFileSync(privateKeyPath, 'utf8')
const secret = process.env.WEBHOOK_SECRET
const enterpriseHostname = process.env.ENTERPRISE_HOSTNAME
const messageForNewPRs = fs.readFileSync('./message.md', 'utf8')
const pubsubTopicName = process.env.PUBSUB_TOPIC_NAME
const cloudProjectId = process.env.CLOUD_PROJECT_ID

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

// Create a Pub/Sub client
const pubsubClient = new PubSub({ cloudProjectId });

// Publish message to Google PubSub
async function publishMessage(message) {
  try {
    console.log(`Publishing message to ${pubsubTopicName}.`)
    const messageId = await pubsubClient.topic(pubsubTopicName).publishMessage({ data: Buffer.from(message) })
    console.log(`Message #${messageId} published.`)
  } catch (error) {
    console.error(`Received error while publishing: ${error.message}`)
  }
}


// Optional: Get & log the authenticated app's name
const { data } = await app.octokit.request('/app')

// Read more about custom logging: https://github.com/octokit/core.js#logging
app.octokit.log.debug(`Authenticated as '${data.name}'`)

// Subscribe to the "issues.opened" webhook event.
// See https://docs.github.com/en/webhooks/webhook-events-and-payloads for more webhook events.
app.webhooks.on('issues.reopened', async ({ octokit, payload }) => {
  let repo_name = payload.repository.full_name
  console.log(`Received a issue reopened event for ${repo_name} #${payload.issue.number}`)

  await publishMessage(repo_name)

  try {
    await octokit.rest.issues.createComment({
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
      issue_number: payload.issue.number,
      body: messageForNewPRs
    })
  } catch (error) {
    if (error.response) {
      console.error(`Error! Status: ${error.response.status}. Message: ${error.response.data.message}`)
    } else {
      console.error(`Recived error while posting a comment to the issue: ${error.message}`)
    }
  }
})

// Optional: Handle errors
app.webhooks.onError((error) => {
  if (error.name === 'AggregateError') {
    // Log Secret verification errors
    console.log(`Error processing request: ${error.event}`)
  } else {
    console.log(error)
  }
})

// Launch a web server to listen for GitHub webhooks
const port = process.env.PORT || 3000
const path = '/api/webhook'
const localWebhookUrl = `http://localhost:${port}${path}`

// See https://github.com/octokit/webhooks.js/#createnodemiddleware for all options
const middleware = createNodeMiddleware(app.webhooks, { path })

http.createServer(middleware).listen(port, () => {
  console.log(`Server is listening for events at: ${localWebhookUrl}`)
  console.log('Press Ctrl + C to quit.')
})
