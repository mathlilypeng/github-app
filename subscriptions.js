import dotenv from 'dotenv'
import fs from 'fs'
import dedent from 'dedent'
import * as diff from 'diff'
import { v4 as uuidv4 } from 'uuid'
import { PubSub } from '@google-cloud/pubsub'
import { Octokit } from 'octokit'
import { createAppAuth } from '@octokit/auth-app'

// Load environment variables from .env file
dotenv.config()

const buildResultTopic = process.env.BOB_THE_BUILDER_RESULT_TOPIC
const cloudProjectId = process.env.CLOUD_PROJECT_ID
const appId = process.env.APP_ID
const privateKeyPath = process.env.PRIVATE_KEY_PATH
const privateKey = fs.readFileSync(privateKeyPath, 'utf8')
const unifiedDiff = dedent`
--- a/main.py
+++ b/main.py
@@ -1,5 +1,10 @@
 """
 This script subscribes to a Pub/Sub topic and prints the message data.
+
+It uses the Google Cloud Pub/Sub library to create a subscriber client and
+subscribe to a topic. The callback function is called for each message received
+and prints the message data.
+
 """
 import os
 from google.cloud import pubsub_v1
@@ -10,6 +15,7 @@ def callback_fun(message: pubsub_v1.subscriber.message.Message):
 """
 This function is called for each message received by the subscriber.
 
+Args:
 message: The message received by the subscriber.
 """
 print(message.data)
@@ -17,6 +23,7 @@ def main(_):
 """
 This is the main function of the script.
 
+It creates a subscriber client, subscribes to a topic, and waits for messages.
 """
 `

function escapeMarkdown(text) {
  // You can add more special characters to this if needed
  return text.replace(/([_*`])/g, '\\$1');
}

function formatBuildResultMessage(buildResult) {
  const formattedMessages = []
  buildResult.history.forEach((historyItem) => {
    const formattedMessage = `Docker File:\n\`\`\`\n${escapeMarkdown(historyItem.docker_file)}\n\`\`\`
    Build Success: ${historyItem.build_success}
    Error Message: ${historyItem.error_logs}`
    formattedMessages.push(formattedMessage)
  })
  return formattedMessages
}


// Handel the build result from Bob the Builder
async function onBobTheBuilderResult(message) {
  const messageStr = message.data.toString('utf8')
  console.log(`Received message: ${messageStr}`);
  const buildResult = JSON.parse(messageStr)
  const octokit = new Octokit({
    authStrategy: createAppAuth, auth: {
      appId: appId,
      privateKey: privateKey,
      installationId: buildResult.issueInfo.installation_id
    }
  })
  const commentBody = formatBuildResultMessage(buildResult).join("\n")
  try {
    await octokit.rest.issues.createComment({
      owner: buildResult.issueInfo.repo_owner,
      repo: buildResult.issueInfo.repo_name,
      issue_number: buildResult.issueInfo.issue_number,
      body: commentBody
    })
  } catch (error) {
    if (error.response) {
      console.error(`Error! Status: ${error.response.status}. Message: ${error.response.data.message}`)
    } else {
      console.error(`Received error while posting a comment to the issue: ${error.message}`)
    }
  }
  message.ack();
}

async function onPatchGenerationResult(message) {
  // const messageStr = message.data.toString('utf8')
  // console.log(`Received message: ${messageStr}`);
  // const patchResult = JSON.parse(messageStr)
  const patchResult = message
  const octokit = new Octokit({
    authStrategy: createAppAuth, auth: {
      appId: appId,
      privateKey: privateKey,
      installationId: patchResult.issueInfo.installation_id
    }
  })
  // Create a new branch
  let baseBranchSha
  try {
    baseBranchSha = await octokit.rest.git.getRef({
      owner: patchResult.issueInfo.repo_owner,
      repo: patchResult.issueInfo.repo_name,
      ref: "heads/main"
    }).then(response => response.data.object.sha)
      .catch(error =>
        console.error(`Received error while getting the ref: ${error}`))
    console.info(`Retrived the base branch sha: ${baseBranchSha}`)
    const newBranchName = `feature-${patchResult.issueInfo.issue_number}-${uuidv4()}`
    await octokit.rest.git.createRef({
      owner: patchResult.issueInfo.repo_owner,
      repo: patchResult.issueInfo.repo_name,
      ref: `refs/heads/${newBranchName}`,
      sha: baseBranchSha,
    })
    console.log(`New branch '${newBranchName}' created successfully!`);
  } catch (error) {
    console.error(`Received error while creating a new branch: ${error}`)
  }

  // Process the unified diff
  const patch = diff.parsePatch(patchResult.unifiedDiff);
  patch.forEach(filePatch => {
    if (filePatch.oldFileName !== '/dev/null') {
      octokit.rest.repos.getContent({
        owner: patchResult.issueInfo.repo_owner,
        repo: patchResult.issueInfo.repo_name,
        path: filePatch.oldFileName.slice(2), // Or filePatch.newFileName if they match
        ref: baseBranchSha,
      }).then(response => {
        console.info(`Retrived the file content ${response.data.name}`)
        const originalContent = Buffer.from(response.data.content, 'base64').toString('utf-8')
        console.info(`Converted the file content to utf-8 string.`)
        const updatedContent = diff.applyPatch(originalContent, filePatch)
        console.info(`Patch applied successfully.`)
        octokit.rest.repos.createOrUpdateFileContents({
          owner: patchResult.issueInfo.repo_owner,
          repo: patchResult.issueInfo.repo_name,
          path: filePatch.oldFileName.slice(2),
          message: `Fix for the issue #${patchResult.issueInfo.issue_number}`,
          content: Buffer.from(updatedContent).toString('base64'),
          committer: {
            name: "AIDA",
            email: "github-actions@github.com)"
          },
          sha: response.data.sha
        })
        console.info(`Done createOrUpdateFileContents.`)
      }).then(console.info("File updated successfully."))
        .catch(error => console.error(`Received error while updating the files: ${error}`))
    } else {
      // Handle newly added files
      console.info(`Found a patch that adds a new file.\n${filePatch.hunks}`)
    }
  })
}

async function createBobTheBuilderResultSubscription() {
  const pubsubClient = new PubSub({ cloudProjectId });
  const subscription = pubsubClient.subscription(buildResultTopic)
  // Start listening for messages
  subscription.on('message', onBobTheBuilderResult)
  subscription.on('error', (error) => console.error(`Recived error while listening to ${buildResultTopic}. Error: ${error}`))
  return subscription
}

async function createPatchGenerationResultSubscription() {
  const message = {
    "issueInfo": {
      "repo_owner": "mathlilypeng",
      "repo_name": "pubsub-hello-world",
      "issue_number": 7,
      "installation_id": 46978601,
    },
    "unifiedDiff": unifiedDiff
  }
  onPatchGenerationResult(message)
}

export const subscriptions = {
  createBobTheBuilderResultSubscription,
  createPatchGenerationResultSubscription,
};