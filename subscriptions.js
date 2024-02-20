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
const patchGenerationResultTopic = process.env.PATCH_GENERATION_RESULT_TOPIC
const cloudProjectId = process.env.CLOUD_PROJECT_ID
const appId = process.env.APP_ID
const privateKeyPath = process.env.PRIVATE_KEY_PATH
const privateKey = fs.readFileSync(privateKeyPath, 'utf8')

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
      console.error(
        `Error! Status: ${error.response.status}. Message: ${error.response.data.message}`)
    } else {
      console.error(`Received error while posting a comment to the issue: ${error.message}`)
    }
    return
  }
  message.ack();
}

async function onPatchGenerationResult(message) {
  const messageStr = message.data.toString('utf8')
  console.log(`Received message: ${messageStr}`);
  const patchResult = JSON.parse(messageStr)
  const octokit = new Octokit({
    authStrategy: createAppAuth, auth: {
      appId: appId,
      privateKey: privateKey,
      installationId: patchResult.taskInfo.installation_id,
    }
  })
  // Get the base branch sha
  const baseBranchName = "main"
  const baseBranchSha = await octokit.rest.git.getRef({
    owner: patchResult.taskInfo.repo_owner,
    repo: patchResult.taskInfo.repo_name,
    ref: `heads/${baseBranchName}`
  }).then(response => response.data.object.sha)
    .catch(error => {
      throw new Error(`Received error while getting the ref for "heads/${baseBranchName}": ${error}`)
    });

  // Create a new branch based on the base branch sha
  const newBranchName = `feature-${patchResult.taskInfo.issue_number}-${uuidv4()}`
  await octokit.rest.git.createRef({
    owner: patchResult.taskInfo.repo_owner,
    repo: patchResult.taskInfo.repo_name,
    ref: `refs/heads/${newBranchName}`,
    sha: baseBranchSha,
  }).then(() => console.log(`New branch '${newBranchName}' created successfully!`))
    .catch(error => {
      throw new Error(`Received error while creating a new branch ${newBranchName}. Error: ${error}`);
    });

  // Process the unified diff
  const patch = diff.parsePatch(patchResult.lastPatchResult.unifiedDiff);
  const fileUpdatePromises = patch.map(filePatch => {
    return octokit.rest.repos.getContent({
      owner: patchResult.taskInfo.repo_owner,
      repo: patchResult.taskInfo.repo_name,
      path: filePatch.oldFileName.slice(2),
      ref: baseBranchSha,
    }).catch(error => {
      throw new Error(`Received error while getting content for ${filePatch.oldFileName}. Error: ${error}`);
    })
      .then(response => {
        const originalContent = Buffer.from(response.data.content, 'base64').toString('utf-8')
        const update = diff.applyPatch(originalContent, filePatch)
        if (update === false) {
          throw new Error(`Failed to apply the patch.`)
        }
        const updatedContent = update
        return octokit.rest.repos.createOrUpdateFileContents({
          owner: patchResult.taskInfo.repo_owner,
          repo: patchResult.taskInfo.repo_name,
          path: filePatch.oldFileName.slice(2),
          message: `Fix for the issue #${patchResult.taskInfo.issue_number}`,
          content: Buffer.from(updatedContent).toString('base64'),
          committer: {
            name: "AIDA",
            email: "github-actions@github.com"
          },
          sha: response.data.sha,
          branch: newBranchName
        })
      })
      .catch(error => {
        throw new Error(`
      Received error while updating ${filePatch.oldFileName} to ${filePatch.newFileName}. Error: ${error}`);
      })
  })

  await Promise.all(fileUpdatePromises)
    .then(() => console.info("File updated successfully."));

  octokit.rest.pulls.create({
    owner: patchResult.taskInfo.repo_owner,
    repo: patchResult.taskInfo.repo_name,
    title: `Fix for issue #${patchResult.taskInfo.issue_number}`,
    head: newBranchName,
    base: baseBranchName  // Or your target branch
  })
    .then(response => console.info(`Created a PR: ${response.data.html_url}`))
    .catch(error => {
      throw new Error(`Received error while creating a pull request: ${error}`);
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
  const pubsubClient = new PubSub({ cloudProjectId });
  const subscription = pubsubClient.subscription(patchGenerationResultTopic)
  // Start listening for messages
  subscription.on('message', onPatchGenerationResult)
  subscription.on('error', (error) => console.error(`Recived error while listening to ${patchGenerationResultTopic}. Error: ${error}`))
  return subscription
}

export const subscriptions = {
  createBobTheBuilderResultSubscription,
  createPatchGenerationResultSubscription,
};