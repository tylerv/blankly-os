/*******************************************************************/
/*                                                                 */
/*                  BLANKLY FINANCE CONFIDENTIAL                   */
/*                   _ _ _ _ _ _ _ _ _ _ _ _ _                     */
/*                                                                 */
/* Copyright 2022 Blankly Finance Incorporated                     */
/* All Rights Reserved.                                            */
/*                                                                 */
/* NOTICE:  All information contained herein is, and remains the   */
/* property of Blankly Finance Incorporated and its suppliers, if  */
/* any.  The intellectual and technical concepts contained         */
/* herein are proprietary to Blankly Finance Incorporated and its  */
/* suppliers and may be covered by U.S. and Foreign Patents,       */
/* patents in process, and are protected by trade secret or        */
/* copyright law.  Dissemination of this information or            */
/* reproduction of this material is strictly forbidden unless      */
/* prior written permission is obtained from Blankly Finance       */
/* Incorporated.                                                   */
/*                                                                 */
/*******************************************************************/

import {getDoc} from "@/libs/firestore";

function getLiveBlanklyMetrics(projectId: string, modelId: string) {
  return getDoc(`projects/${projectId}/models/${modelId}/metrics/blankly`)
}

function getLiveCustomMetrics(projectId: string, modelId: string) {
  return getDoc(`/projects/${projectId}/models/${modelId}/metrics/custom`)
}

function getLiveBlanklyTimeseriesMetrics(projectId: string, modelId: string) {
  return getDoc(`projects/${projectId}/models/${modelId}/timeseriesMetrics/blankly`)
}

export {getLiveBlanklyMetrics, getLiveBlanklyTimeseriesMetrics, getLiveCustomMetrics}
