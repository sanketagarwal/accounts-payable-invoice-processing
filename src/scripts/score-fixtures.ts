import { extractionFidelityScorer } from '../mastra/scorers/extraction-fidelity.ts'
import { invoiceFixtures, runFixture } from './support.ts'

const scores: number[] = [], failures: string[] = []
for (const fixture of invoiceFixtures) {
  const { result } = await runFixture(fixture)
  const score = await extractionFidelityScorer.run({ input: fixture.groundTruth, output: result.extractedResult })
  scores.push(score.score)
  if (score.score < 1) failures.push(fixture.document.id)
  console.log(`${fixture.document.id}: ${score.score.toFixed(3)} ${score.reason}`)
}
console.log(`mean=${(scores.reduce((sum, score) => sum + score, 0) / scores.length).toFixed(3)} failing=${failures.join(',') || 'none'}`)
